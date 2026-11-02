/**
 * Collections read from PostgreSQL (and PostGIS) tables, filtered in the database with `ogc-cql2/sql`'s `postgres`
 * dialect.
 *
 * - The connection comes from PostgreSQL's own environment variables (`PGHOST`, `PGDATABASE`, `PGUSER`,
 *   `PGPASSWORD`…), which `npm start` loads from `.env`.
 * - Only the tables listed in `collections.json` are served: a database may hold anything, so nothing is served by
 *   discovery.
 * - The queryables come from the columns' declared types; the id is the primary key (or `id` in the config); a PostGIS
 *   geometry column (from `geometry_columns`) is the geometry, read as WKB and converted to WGS 84 (`ST_Transform`)
 *   when its SRID isn't 4326.
 * - Values are selected through `postgresValue`, so what is served is exactly what the SQL compares.
 */
import pg from "pg";
import type { Cql2Filter } from "ogc-cql2";
import { postgresValue, sqlConformance, toSql, type SqlColumn } from "ogc-cql2/sql";
import { decodeWkb } from "../geopackage/binary.ts";
import { type CollectionDescription, type Feature, type Queryable, type Store } from "./types.ts";

export interface PostgresTable {
  /** `schema.table`, or `table` on the search path. */
  readonly table: string;
  /** The id column, when it isn't the (single-column) primary key. */
  readonly id?: string;
  readonly title?: string;
}

export interface PostgresSource {
  readonly tables: readonly PostgresTable[];
  /** Put before each table name to make its collection id. */
  readonly prefix?: string;
  /** Where `postgresFunctions` created the `cql2_*` functions; default the search path. */
  readonly functionSchema?: string;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const ID = /^[A-Za-z0-9_-]+$/;

/** A PostgreSQL type (as `format_type` names it) → queryable; `undefined` for a type the dialect can't compare. */
function queryableOf(sqlType: string): Queryable | undefined {
  const t = sqlType.toLowerCase().replace(/\(\s*\d+\s*(?:,\s*\d+\s*)?\)/g, "").replace(/\s+/g, " ").trim();
  if (["text", "character varying", "character", "name", "citext"].includes(t)) return { type: "string" };
  if (["smallint", "integer", "bigint"].includes(t)) return { type: "integer" };
  if (["real", "double precision", "numeric"].includes(t)) return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "date") return { type: "string", format: "date" };
  if (t === "timestamp with time zone") return { type: "string", format: "date-time" };
  if (t === "timestamp without time zone") return { type: "string" }; // no offset: not an instant
  return undefined;
}

/** A pool for the environment's connection. bigint (ids, values) is read as a number, as GeoJSON serves it. */
export function createPool(): pg.Pool {
  pg.types.setTypeParser(pg.types.builtins.INT8, Number);
  return new pg.Pool({ max: 4 });
}

/** Makes one store per listed table. A table that can't be served is reported and left out. */
export async function openPostgres(
  pool: pg.Pool,
  source: PostgresSource,
): Promise<{ stores: { id: string; store: Store }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const stores: { id: string; store: Store }[] = [];
  if (source.functionSchema) {
    const s = quote(source.functionSchema);
    const { rows } = await pool.query(
      "SELECT to_regprocedure($1) IS NOT NULL AS casei, to_regprocedure($2) IS NOT NULL AS accenti, to_regprocedure($3) IS NOT NULL AS arithmetic",
      [`${s}.cql2_casei(text)`, `${s}.cql2_accenti(text)`, `${s}.cql2_arithmetic(text, double precision, double precision)`],
    );
    const where = `schema "${source.functionSchema}"`;
    const fix = "filters using CASEI, ACCENTI or arithmetic, or dates in text, will fail. Run postgresFunctions there (load-postgres.sh does).";
    if (!rows[0].casei) warnings.push(`The cql2_* functions aren't in ${where}: ${fix}`);
    else if (!rows[0].accenti) warnings.push(`The cql2_* functions in ${where} lack cql2_accenti (added in ogc-cql2 0.5.0): ${fix}`);
    else if (!rows[0].arithmetic) warnings.push(`The cql2_* functions in ${where} lack cql2_arithmetic (added in ogc-cql2 1.2.0): ${fix}`);
  }
  for (const entry of source.tables) {
    const name = entry.table.split(".").pop()!;
    const id = `${source.prefix ?? ""}${name}`;
    if (!ID.test(id)) {
      warnings.push(`Table "${entry.table}" not served: "${id}" isn't a valid collection id.`);
      continue;
    }
    try {
      stores.push({ id, store: await tableStore(pool, id, entry, source.functionSchema) });
    } catch (error) {
      warnings.push(`Table "${entry.table}" not served: ${(error as Error).message}`);
    }
  }
  return { stores, warnings };
}

async function tableStore(pool: pg.Pool, id: string, entry: PostgresTable, functionSchema: string | undefined): Promise<Store> {
  const { rows: found } = await pool.query("SELECT to_regclass($1)::oid AS oid", [entry.table]);
  const oid = found[0].oid as number | null;
  if (oid === null) throw new Error("there is no such table (or no permission to see it).");
  const relation = (
    await pool.query(
      "SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name, n.nspname AS schema, c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1",
      [oid],
    )
  ).rows[0] as { name: string; schema: string; table: string };

  const { rows: attributes } = await pool.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, t.typname AS typname
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [oid],
  );
  const { rows: keys } = await pool.query(
    `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1 AND i.indisprimary`,
    [oid],
  );
  const idColumn = entry.id ?? (keys.length === 1 ? (keys[0].name as string) : undefined);
  if (!idColumn || !attributes.some((a) => a.name === idColumn)) {
    throw new Error(entry.id ? `it has no column "${entry.id}".` : `it has no single-column primary key; set "id" in collections.json.`);
  }

  const warnings: string[] = [];
  const geometryAttribute = attributes.find((a) => a.typname === "geometry");
  let geometrySelect: string | undefined;
  /** The geometry column for spatial filters, as the server names it in the queryables: "geometry". */
  let geometryColumn: SqlColumn | undefined;
  if (geometryAttribute) {
    const { rows } = await pool.query(
      "SELECT srid FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = $3",
      [relation.schema, relation.table, geometryAttribute.name],
    );
    const srid = Number(rows[0]?.srid ?? 0);
    const g = quote(geometryAttribute.name);
    if (srid > 0) geometryColumn = { sqlType: "geometry", srid, column: geometryAttribute.name };
    if (srid === 4326) geometrySelect = `ST_AsBinary(${g})`;
    else if (srid > 0) geometrySelect = `ST_AsBinary(ST_Transform(${g}, 4326))`;
    else warnings.push(`Its geometry column "${geometryAttribute.name}" has no SRID: features are served without geometry.`);
  }

  const queryables: Record<string, Queryable> = {};
  const columns: Record<string, SqlColumn> = {};
  for (const a of attributes as { name: string; type: string; typname: string }[]) {
    if (a.name === idColumn || a.name === geometryAttribute?.name) continue;
    const q = queryableOf(a.type);
    if (!q) {
      warnings.push(`Column "${a.name}" (${a.type}) isn't queryable and isn't served.`);
      continue;
    }
    queryables[a.name] = q;
    columns[a.name] = { ...q, sqlType: a.type };
  }

  const names = Object.keys(columns);
  const select = [
    `${quote(idColumn)} AS id`,
    ...(geometrySelect ? [`${geometrySelect} AS geometry`] : []),
    ...names.map((n) => `${postgresValue(n, columns[n]!)} AS ${quote(n)}`),
  ].join(", ");
  const featureCount = Number((await pool.query(`SELECT count(*) AS n FROM ${relation.name}`)).rows[0].n);

  const description: CollectionDescription = {
    id,
    title: entry.title ?? relation.table,
    source: "postgres",
    featureCount,
    warnings,
  };
  const toFeature = (row: Record<string, unknown>): Feature => {
    const properties: Record<string, unknown> = {};
    for (const n of names) properties[n] = row[n];
    const bytes = row.geometry;
    return {
      type: "Feature",
      id: row.id as string | number,
      geometry: bytes instanceof Uint8Array ? decodeWkb(bytes) : null,
      properties,
    };
  };

  return {
    describe: () => description,
    queryables: () => queryables,
    hasGeometry: () => geometryColumn !== undefined,
    conformance: () => sqlConformance({ dialect: "postgres" }), // the spatial classes through PostGIS
    async query(filter: Cql2Filter, { limit, offset }) {
      const filterColumns = geometryColumn && !Object.hasOwn(columns, "geometry") ? { ...columns, geometry: geometryColumn } : columns;
      const { where, params } = toSql(filter, { dialect: "postgres", columns: filterColumns, ...(functionSchema ? { functionSchema } : {}) });
      const n = params.length;
      const [page, count] = await Promise.all([
        pool.query(`SELECT ${select} FROM ${relation.name} WHERE ${where} ORDER BY ${quote(idColumn)} LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit, offset]),
        pool.query(`SELECT count(*) AS n FROM ${relation.name} WHERE ${where}`, [...params]),
      ]);
      return { features: page.rows.map(toFeature), numberMatched: Number(count.rows[0].n) };
    },
  };
}
