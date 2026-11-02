/**
 * How a GeoParquet file is served and filtered through the `duckdb` dialect: the queryables from the types `DESCRIBE`
 * gives, the geometry column from the file's `geo` metadata (GeoParquet 1.1), and the SQL of a query. Without DuckDB
 * itself, so that demo-server's store (Node) and the playground's DuckDB-WASM worker read files the same way: each
 * runs the SQL given here on its own connection.
 */
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { duckdbValue, sqlConformance, toSql, type SqlColumn } from "ogc-cql2/sql";
import { decodeWkb } from "../geopackage/binary.ts";
import type { Feature, Queryable } from "./types.ts";

const bare = (sqlType: string): string => sqlType.toLowerCase().replace(/\(.*\)$/, "").trim();

const TEXT = ["varchar", "char", "bpchar", "text", "string"];
const INTEGER = ["tinyint", "smallint", "integer", "int", "bigint", "hugeint", "utinyint", "usmallint", "uinteger", "ubigint", "uhugeint"];
const NUMBER = ["float", "real", "double", "decimal", "numeric"];

/** A DuckDB type (as `DESCRIBE` names it) → queryable; `undefined` for a type the dialect can't compare. */
export function queryableOf(sqlType: string): Queryable | undefined {
  const t = bare(sqlType);
  if (TEXT.includes(t)) return { type: "string" };
  if (INTEGER.includes(t)) return { type: "integer" };
  if (NUMBER.includes(t)) return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "date") return { type: "string", format: "date" };
  if (t === "timestamp with time zone") return { type: "string", format: "date-time" };
  if (t.startsWith("timestamp")) return { type: "string" }; // no time zone: not an instant
  return undefined;
}

/** CRS84 or EPSG:4326, which GeoParquet stores as longitude, latitude; no `crs` member means CRS84. */
function isWgs84(crs: unknown): boolean {
  if (crs === undefined) return true;
  const id = (crs as { id?: { authority?: unknown; code?: unknown } } | null)?.id;
  return (id?.authority === "OGC" && id.code === "CRS84") || (id?.authority === "EPSG" && Number(id.code) === 4326);
}

const isPath = (p: unknown): p is [string, string] => Array.isArray(p) && p.length === 2 && p.every((s) => typeof s === "string");

export interface GeometryColumn {
  /** The column, as `toSql` takes it: GEOMETRY (or WKB in a BLOB), with the covering when the file has one. */
  readonly column?: SqlColumn & { readonly column: string };
  /** The geometry columns, and the covering's, which aren't properties. */
  readonly hidden: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * The file's primary geometry column, from its `geo` metadata (the JSON text, or `undefined` for a plain Parquet
 * file) and the types `DESCRIBE` gave. Served only when it's WKB in WGS 84 with planar edges, as GeoJSON and CQL2's
 * functions take it; otherwise reported, and the features have no geometry.
 */
export function geometryOf(geo: string | undefined, types: Readonly<Record<string, string>>): GeometryColumn {
  if (geo === undefined) return { hidden: [], warnings: [] };
  const meta = JSON.parse(geo) as { primary_column?: string; columns?: Record<string, Record<string, unknown>> };
  const hidden = Object.keys(meta.columns ?? {});
  const name = meta.primary_column;
  const info = name === undefined ? undefined : meta.columns?.[name];
  const covering = (info?.covering as { bbox?: Record<string, unknown> } | undefined)?.bbox;
  if (covering) for (const p of Object.values(covering)) if (isPath(p)) hidden.push(p[0]);
  const no = (why: string) => ({ hidden, warnings: [`Its geometry column "${name ?? "(no primary_column)"}" ${why}: features are served without geometry.`] });
  if (name === undefined || !info || types[name] === undefined) return no("isn't in the file");
  if (info.encoding !== "WKB") return no(`is encoded as ${String(info.encoding)}, not WKB`);
  if (!isWgs84(info.crs)) return no("isn't in WGS 84 (CRS84)");
  if (info.edges !== undefined && info.edges !== "planar") return no(`has ${String(info.edges)} edges, not planar`);
  const sqlType = /^geometry\b/i.test(types[name]!) ? "GEOMETRY" : "BLOB";
  const paths = covering && (["xmin", "ymin", "xmax", "ymax"] as const).every((k) => isPath(covering[k]) && types[covering[k][0]] !== undefined);
  return {
    column: { sqlType, column: name, ...(paths ? { covering: { bbox: covering as Record<"xmin" | "ymin" | "xmax" | "ymax", [string, string]> } } : {}) },
    hidden: [...new Set(hidden)],
    warnings: covering && !paths ? [`Its bbox covering isn't usable (not four [column, field] paths of the file): filters test every row.`] : [],
  };
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** What to read from a file first: its columns (`column_name`, `column_type`), and its `geo` metadata (`geo`). */
/**
 * The classes a DuckDB table serves: the dialect's, without the spatial ones when DuckDB's spatial extension isn't
 * loaded (which the package can't know).
 */
export const duckdbConformance = (spatial: boolean): string[] => {
  const none = [CONFORMANCE.basicSpatial, CONFORMANCE.basicSpatialPlus, CONFORMANCE.spatial];
  return sqlConformance({ dialect: "duckdb" }).filter((c) => spatial || !none.includes(c));
};

export const describeSql = (file: string): string => `DESCRIBE SELECT * FROM read_parquet(${literal(file)})`;
export const geoSql = (file: string): string =>
  `SELECT decode(value) AS geo FROM parquet_kv_metadata(${literal(file)}) WHERE decode(key) = 'geo'`;

export interface ParquetTable {
  readonly queryables: Readonly<Record<string, Queryable>>;
  readonly warnings: readonly string[];
  /** Whether spatial filters can run: a geometry column, and the spatial extension loaded. */
  readonly filterable: boolean;
  /** One row: `n` rows, `ids` ids, `distinct_ids` distinct ids. The id column must be unique and never NULL. */
  readonly idCheckSql: string;
  /** The SQL of one page of the features a filter selects, ordered by id, and of their count (`n`). */
  query(filter: Cql2Filter, limit: number, offset: number): { page: string; count: string; params: unknown[] };
  /** A row of the page as a GeoJSON feature. */
  toFeature(row: Readonly<Record<string, unknown>>): Feature;
}

/** BIGINT comes back as a bigint: served as a number, as GeoJSON has it. */
const plain = (value: unknown): unknown => (typeof value === "bigint" ? Number(value) : value);

/**
 * The file's table, from what {@link describeSql} and {@link geoSql} read. Throws if it can't be served: no id
 * column, or one that isn't an integer or text.
 */
export function parquetTable(
  file: string,
  types: Readonly<Record<string, string>>,
  geo: string | undefined,
  { idColumn = "id", spatial }: { idColumn?: string; spatial: boolean },
): ParquetTable {
  const geometry = geometryOf(geo, types);
  const warnings = [...geometry.warnings];
  const idType = types[idColumn] === undefined ? undefined : queryableOf(types[idColumn]!)?.type;
  if (idType !== "integer" && idType !== "string") {
    throw new Error(types[idColumn] === undefined ? `it has no column "${idColumn}"; set "idColumn" in collections.json.` : `its id column "${idColumn}" is ${types[idColumn]}, not an integer or text.`);
  }

  const queryables: Record<string, Queryable> = {};
  const columns: Record<string, SqlColumn> = {};
  for (const [name, sqlType] of Object.entries(types)) {
    if (name === idColumn || geometry.hidden.includes(name)) continue;
    const q = queryableOf(sqlType);
    if (!q) {
      warnings.push(`Column "${name}" (${sqlType}) isn't queryable and isn't served.`);
      continue;
    }
    queryables[name] = q;
    columns[name] = { ...q, sqlType };
  }

  const from = `read_parquet(${literal(file)})`;
  const id = quote(idColumn);
  const g = geometry.column;
  const names = Object.keys(columns);
  const select = [
    `${id} AS id`,
    ...(g ? [`${quote(g.column)}${g.sqlType === "GEOMETRY" ? "::BLOB" : ""} AS geometry`] : []),
    ...names.map((n) => `${duckdbValue(n, columns[n]!)} AS ${quote(n)}`),
  ].join(", ");
  const filterable = spatial && g !== undefined;
  const filterColumns = filterable && !Object.hasOwn(columns, "geometry") ? { ...columns, geometry: g } : columns;

  return {
    queryables,
    warnings,
    filterable,
    idCheckSql: `SELECT count(*) AS n, count(${id}) AS ids, count(DISTINCT ${id}) AS distinct_ids FROM ${from}`,
    query(filter, limit, offset) {
      if (!Number.isInteger(limit) || !Number.isInteger(offset)) throw new TypeError("limit and offset must be integers");
      const { where, params } = toSql(filter, { dialect: "duckdb", columns: filterColumns });
      return {
        page: `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${id} LIMIT ${limit} OFFSET ${offset}`,
        count: `SELECT count(*) AS n FROM ${from} WHERE ${where}`,
        params: [...params],
      };
    },
    toFeature(row) {
      const properties: Record<string, unknown> = {};
      for (const n of names) properties[n] = plain(row[n]);
      // A BLOB: a Uint8Array in DuckDB-WASM, a value holding one in @duckdb/node-api.
      const blob = row.geometry as Uint8Array | { bytes: Uint8Array } | null | undefined;
      const bytes = blob instanceof Uint8Array ? blob : blob?.bytes;
      return { type: "Feature", id: plain(row.id) as string | number, geometry: bytes ? decodeWkb(bytes) : null, properties };
    },
  };
}
