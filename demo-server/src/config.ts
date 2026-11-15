/**
 * `collections.json`: which collections the server serves, and from where.
 *
 * ```json
 * { "collections": [
 *   { "id": "states", "title": "US states", "source": "geojson", "file": "data/states.geojson" },
 *   { "id": "parquet-states", "title": "US states", "source": "geoparquet", "file": "data/states.parquet" },
 *   { "source": "geopackage", "file": "data/usa.gpkg", "prefix": "gpkg-", "tables": ["states"] },
 *   { "source": "postgres", "prefix": "pg-", "functionSchema": "cql2demo", "tables": [{ "table": "cql2demo.states" }] },
 *   { "source": "oracle", "prefix": "ora-", "tables": [{ "table": "KITCHEN_SINK", "days": ["day"] }] },
 *   { "source": "sqlserver", "prefix": "ms-", "tables": [{ "table": "dbo.states" }] }
 * ] }
 * ```
 * A `geojson` entry is one collection, and so is a `geoparquet` entry (a GeoParquet or Parquet file, read in place by
 * DuckDB; its id column is `id` unless `idColumn` names another). A `geopackage` entry is one collection per table the GeoPackage lists (or only
 * `tables`), each with the id `prefix` + table name. A `postgres`, `oracle` or `sqlserver` entry is one collection per
 * listed table, from the database the environment names (`.env`: `PG*`, `ORACLE_*`, `MSSQL_*`); an Oracle table may list
 * its DATE columns that hold days (`days`). Files are relative to the directory of `collections.json`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type CollectionConfig =
  | { readonly source: "geojson"; readonly id: string; readonly title: string; readonly file: string }
  | { readonly source: "geoparquet"; readonly id: string; readonly title: string; readonly file: string; readonly idColumn?: string }
  | { readonly source: "geopackage"; readonly file: string; readonly prefix?: string; readonly tables?: readonly string[] }
  | {
      readonly source: "postgres" | "oracle" | "sqlserver";
      readonly tables: readonly { readonly table: string; readonly id?: string; readonly title?: string; readonly days?: readonly string[] }[];
      readonly prefix?: string;
      readonly functionSchema?: string;
    };

const ID = /^[A-Za-z0-9_-]+$/;

/** Reads and checks the configuration; throws with every problem found, so a broken file never half-starts. */
export function readConfig(path: string): CollectionConfig[] {
  const json = JSON.parse(readFileSync(path, "utf8")) as { collections?: unknown };
  if (!Array.isArray(json.collections)) throw new Error(`${path}: "collections" must be an array.`);
  const problems: string[] = [];
  const seen = new Set<string>();
  const out: CollectionConfig[] = [];
  json.collections.forEach((entry: Record<string, unknown>, i) => {
    const where = `${path}: collections[${i}]`;
    if (entry.source === "postgres" || entry.source === "oracle" || entry.source === "sqlserver") {
      const tables = entry.tables;
      const days = (t: Record<string, unknown>) =>
        t.days === undefined || (entry.source === "oracle" && Array.isArray(t.days) && t.days.every((d) => typeof d === "string"));
      const ok = Array.isArray(tables) && tables.length > 0 && tables.every((t: Record<string, unknown>) =>
        typeof t === "object" && t !== null && typeof t.table === "string" &&
        (t.id === undefined || typeof t.id === "string") && (t.title === undefined || typeof t.title === "string") && days(t));
      if (!ok) {
        problems.push(`${where}: "tables" must list { "table": "schema.table", "id"?, "title"?${entry.source === "oracle" ? `, "days"?` : ""} }.`);
        return;
      }
      if (entry.prefix !== undefined && (typeof entry.prefix !== "string" || !/^[A-Za-z0-9_-]*$/.test(entry.prefix))) {
        problems.push(`${where}: "prefix" must use letters, digits, "_" or "-".`);
        return;
      }
      out.push({
        source: entry.source,
        tables: tables as { table: string; id?: string; title?: string; days?: string[] }[],
        ...(entry.prefix !== undefined ? { prefix: entry.prefix as string } : {}),
        ...(typeof entry.functionSchema === "string" ? { functionSchema: entry.functionSchema } : {}),
      });
      return;
    }
    if (typeof entry.file !== "string") {
      problems.push(`${where}: "file" must be the path of the data file.`);
      return;
    }
    const file = resolve(dirname(path), entry.file);
    if (entry.source === "geojson" || entry.source === "geoparquet") {
      if (typeof entry.id !== "string" || !ID.test(entry.id)) {
        problems.push(`${where}: "id" must use letters, digits, "_" or "-".`);
        return;
      }
      if (seen.has(entry.id)) problems.push(`${where}: the id "${entry.id}" is used twice.`);
      seen.add(entry.id);
      const title = typeof entry.title === "string" ? entry.title : entry.id;
      if (entry.source === "geojson") {
        out.push({ source: "geojson", id: entry.id, title, file });
      } else if (entry.idColumn !== undefined && typeof entry.idColumn !== "string") {
        problems.push(`${where}: "idColumn" must be a column name.`);
      } else {
        out.push({ source: "geoparquet", id: entry.id, title, file, ...(entry.idColumn !== undefined ? { idColumn: entry.idColumn as string } : {}) });
      }
    } else if (entry.source === "geopackage") {
      if (entry.prefix !== undefined && (typeof entry.prefix !== "string" || !/^[A-Za-z0-9_-]*$/.test(entry.prefix))) {
        problems.push(`${where}: "prefix" must use letters, digits, "_" or "-".`);
        return;
      }
      if (entry.tables !== undefined && (!Array.isArray(entry.tables) || !entry.tables.every((t) => typeof t === "string"))) {
        problems.push(`${where}: "tables" must be a list of table names.`);
        return;
      }
      out.push({
        source: "geopackage",
        file,
        ...(entry.prefix !== undefined ? { prefix: entry.prefix as string } : {}),
        ...(entry.tables !== undefined ? { tables: entry.tables as string[] } : {}),
      });
    } else {
      problems.push(`${where}: source "${String(entry.source)}" is not supported; use "geojson", "geoparquet", "geopackage", "postgres", "oracle" or "sqlserver".`);
    }
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return out;
}
