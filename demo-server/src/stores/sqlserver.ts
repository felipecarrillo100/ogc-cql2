/**
 * Collections read from SQL Server tables (2022 and later), filtered in the database with `ogc-cql2/sql`'s `sqlserver`
 * dialect: S_INTERSECTS on `geometry` columns (Basic Spatial Functions; the dialect has no Spatial Functions).
 *
 * - The connection comes from `MSSQL_SERVER`, `MSSQL_PORT`, `MSSQL_DATABASE`, `MSSQL_USER` and `MSSQL_PASSWORD`, which
 *   `npm start` loads from `.env` (the `mssql` driver; `MSSQL_ENCRYPT=false` for a server without TLS).
 * - Only the tables listed are served, by name (`dbo.kitchen_sink`).
 * - The queryables come from the columns' types (`sys.columns`); the id is the primary key (or `id` in the config). An
 *   nvarchar column in `Latin1_General_100_BIN2`, which loses characters past U+FFFF when converted, isn't served.
 * - A `geometry` column in SRID 4326 is the geometry, served as WKB (exact); in another SRID, or `geography` (not
 *   planar), it is served without geometry, reported.
 * - Values are selected through `sqlserverValue`, so what is served is exactly what the SQL compares.
 */
import mssql from "mssql";
import type { Cql2Filter } from "ogc-cql2";
import { sqlConformance, sqlserverValue, toSql, type SqlColumn } from "ogc-cql2/sql";
import { decodeWkb } from "../geopackage/binary.ts";
import { type CollectionDescription, type Feature, type Queryable, type Store } from "./types.ts";

export interface SqlServerTable {
  /** `schema.table`, or `table` in `dbo`. */
  readonly table: string;
  /** The id column, when it isn't the (single-column) primary key. */
  readonly id?: string;
  readonly title?: string;
}

export interface SqlServerSource {
  readonly tables: readonly SqlServerTable[];
  /** Put before each table name to make its collection id. */
  readonly prefix?: string;
  /** Where `sqlserverFunctions` created the `cql2_*` functions; default `dbo`. */
  readonly functionSchema?: string;
}

const bracket = (name: string): string => `[${name.replaceAll("]", "]]")}]`;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const ID = /^[A-Za-z0-9_-]+$/;

/** A SQL Server type → queryable; `undefined` for a type the dialect can't compare. */
function queryableOf(type: string, scale: number): Queryable | undefined {
  if (["varchar", "char", "nvarchar", "nchar"].includes(type)) return { type: "string" };
  if (["int", "bigint", "smallint", "tinyint"].includes(type)) return { type: "integer" };
  if (["decimal", "numeric"].includes(type)) return { type: scale === 0 ? "integer" : "number" };
  if (["float", "real", "money", "smallmoney"].includes(type)) return { type: "number" };
  if (type === "bit") return { type: "boolean" };
  if (type === "date") return { type: "string", format: "date" };
  if (type === "datetimeoffset") return { type: "string", format: "date-time" };
  if (["datetime2", "datetime", "smalldatetime"].includes(type)) return { type: "string" }; // no zone: not an instant
  return undefined;
}

/** A pool for the environment's connection. */
export function createSqlServerPool(): Promise<mssql.ConnectionPool> {
  return new mssql.ConnectionPool({
    server: process.env.MSSQL_SERVER ?? "localhost",
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options: { encrypt: process.env.MSSQL_ENCRYPT !== "false", trustServerCertificate: true },
    pool: { max: 4 },
  }).connect();
}

/** A query whose parameters are bound by name: `params[i]` as `p<i+1>`, as the dialect writes them; others as named. */
const run = async <T = Record<string, unknown>>(pool: mssql.ConnectionPool, sql: string, params: readonly unknown[] = [], named: Record<string, unknown> = {}): Promise<T[]> => {
  const request = pool.request();
  params.forEach((value, i) => request.input(`p${i + 1}`, value));
  for (const [name, value] of Object.entries(named)) request.input(name, value);
  return (await request.query<T>(sql)).recordset;
};

/** Makes one store per listed table. A table that can't be served is reported and left out. */
export async function openSqlServer(
  pool: mssql.ConnectionPool,
  source: SqlServerSource,
): Promise<{ stores: { id: string; store: Store }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const stores: { id: string; store: Store }[] = [];
  const schema = source.functionSchema ?? "dbo";
  const names = ["cql2_casei", "cql2_accenti", "cql2_like", "cql2_day", "cql2_instant", "cql2_arithmetic"];
  const [found] = await run<{ n: number }>(pool, `SELECT COUNT(*) AS n FROM sys.objects WHERE schema_id = SCHEMA_ID(@s) AND name IN (${names.map((n) => `'${n}'`).join(", ")})`, [], { s: schema });
  if (found!.n < names.length) {
    warnings.push(`The cql2_* functions aren't in schema "${schema}": filters using CASEI, ACCENTI, LIKE with _, arithmetic, or dates in text, will fail. Run sqlserverFunctions there (load-sqlserver.ts does).`);
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

async function tableStore(pool: mssql.ConnectionPool, id: string, entry: SqlServerTable, functionSchema: string | undefined): Promise<Store> {
  const [schemaName, tableName] = entry.table.includes(".") ? entry.table.split(".", 2) as [string, string] : ["dbo", entry.table];
  const relation = `${bracket(schemaName)}.${bracket(tableName)}`;
  const [object] = await run<{ id: number | null }>(pool, "SELECT OBJECT_ID(@t, 'U') AS id", [], { t: relation });
  if (!object?.id) throw new Error("there is no such table (or no permission to see it).");
  const columnsInfo = await run<{ name: string; type: string; scale: number; collation: string | null }>(
    pool,
    `SELECT c.name, t.name AS type, c.scale, c.collation_name AS collation FROM sys.columns c
       JOIN sys.types t ON t.user_type_id = c.user_type_id WHERE c.object_id = @o ORDER BY c.column_id`,
    [], { o: object.id },
  );
  const keys = await run<{ name: string }>(
    pool,
    `SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.object_id = @o AND i.is_primary_key = 1`,
    [], { o: object.id },
  );
  const idColumn = entry.id ?? (keys.length === 1 ? keys[0]!.name : undefined);
  if (!idColumn || !columnsInfo.some((c) => c.name === idColumn)) {
    throw new Error(entry.id ? `it has no column "${entry.id}".` : `it has no single-column primary key; set "id" in the config.`);
  }

  const warnings: string[] = [];
  const geometryInfo = columnsInfo.find((c) => c.type === "geometry");
  let geometryColumn: SqlColumn | undefined;
  if (geometryInfo) {
    const [row] = await run<{ srid: number | null }>(pool, `SELECT TOP 1 ${bracket(geometryInfo.name)}.STSrid AS srid FROM ${relation} WHERE ${bracket(geometryInfo.name)} IS NOT NULL`);
    const srid = row?.srid ?? 4326;
    if (srid === 4326) geometryColumn = { format: "geometry-any", sqlType: "geometry", column: geometryInfo.name };
    else warnings.push(`Its geometry column "${geometryInfo.name}" is in SRID ${srid}: features are served without geometry.`);
  }
  const queryables: Record<string, Queryable> = {};
  const columns: Record<string, SqlColumn> = {};
  for (const c of columnsInfo) {
    if (c.name === idColumn || c.name === geometryInfo?.name) continue;
    if (c.type === "geography") {
      warnings.push(`Column "${c.name}" (geography) isn't served: it is ellipsoidal, and CQL2 compares planar coordinates.`);
      continue;
    }
    const q = queryableOf(c.type, c.scale);
    if (!q) {
      warnings.push(`Column "${c.name}" (${c.type}) isn't queryable and isn't served.`);
      continue;
    }
    if (c.collation === "Latin1_General_100_BIN2" && (c.type === "nvarchar" || c.type === "nchar")) {
      warnings.push(`Column "${c.name}" (${c.type} ${c.collation}) isn't served: that collation loses characters past U+FFFF when converted.`);
      continue;
    }
    queryables[c.name] = q;
    columns[c.name] = { ...q, sqlType: c.type };
  }

  const names = Object.keys(columns);
  const select = [
    `${quote(idColumn)} AS "id"`,
    ...(geometryColumn ? [`${sqlserverValue(geometryColumn.column!, geometryColumn)} AS "geometry"`] : []),
    ...names.map((n) => `${sqlserverValue(n, columns[n]!)} AS ${quote(n)}`),
  ].join(", ");
  const [count] = await run<{ n: number }>(pool, `SELECT COUNT(*) AS n FROM ${relation}`);
  const description: CollectionDescription = { id, title: entry.title ?? tableName, source: "sqlserver", featureCount: count!.n, warnings };
  const toFeature = (row: Record<string, unknown>): Feature => {
    const properties: Record<string, unknown> = {};
    for (const n of names) properties[n] = row[n];
    const bytes = row.geometry;
    return { type: "Feature", id: row.id as string | number, geometry: bytes instanceof Uint8Array ? decodeWkb(bytes) : null, properties };
  };

  return {
    describe: () => description,
    queryables: () => queryables,
    hasGeometry: () => geometryColumn !== undefined,
    conformance: () => sqlConformance({ dialect: "sqlserver" }),
    async query(filter: Cql2Filter, { limit, offset }) {
      const filterColumns = geometryColumn && !Object.hasOwn(columns, "geometry") ? { ...columns, geometry: geometryColumn } : columns;
      const { where, params } = toSql(filter, { dialect: "sqlserver", columns: filterColumns, ...(functionSchema ? { functionSchema } : {}) });
      const [page, total] = await Promise.all([
        run(pool, `SELECT ${select} FROM ${relation} WHERE ${where} ORDER BY ${quote(idColumn)} OFFSET @cql2_offset ROWS FETCH NEXT @cql2_limit ROWS ONLY`, params, { cql2_offset: offset, cql2_limit: limit }),
        run<{ n: number }>(pool, `SELECT COUNT(*) AS n FROM ${relation} WHERE ${where}`, params),
      ]);
      return { features: page.map(toFeature), numberMatched: total[0]!.n };
    },
  };
}
