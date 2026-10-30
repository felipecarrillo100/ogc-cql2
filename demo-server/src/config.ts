/**
 * `collections.json`: which collections the server serves, and from where.
 *
 * ```json
 * { "collections": [
 *   { "id": "states", "title": "US states", "source": "geojson", "file": "data/states.geojson" },
 *   { "source": "geopackage", "file": "data/usa.gpkg", "prefix": "gpkg-", "tables": ["states"] }
 * ] }
 * ```
 * A `geojson` entry is one collection. A `geopackage` entry is one collection per table the GeoPackage lists (or only
 * `tables`), each with the id `prefix` + table name. Files are relative to the directory of `collections.json`.
 * `postgres` comes later.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type CollectionConfig =
  | { readonly source: "geojson"; readonly id: string; readonly title: string; readonly file: string }
  | { readonly source: "geopackage"; readonly file: string; readonly prefix?: string; readonly tables?: readonly string[] };

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
    if (typeof entry.file !== "string") {
      problems.push(`${where}: "file" must be the path of the data file.`);
      return;
    }
    const file = resolve(dirname(path), entry.file);
    if (entry.source === "geojson") {
      if (typeof entry.id !== "string" || !ID.test(entry.id)) {
        problems.push(`${where}: "id" must use letters, digits, "_" or "-".`);
        return;
      }
      if (seen.has(entry.id)) problems.push(`${where}: the id "${entry.id}" is used twice.`);
      seen.add(entry.id);
      out.push({ source: "geojson", id: entry.id, title: typeof entry.title === "string" ? entry.title : entry.id, file });
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
      problems.push(`${where}: source "${String(entry.source)}" is not supported (yet); use "geojson" or "geopackage".`);
    }
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return out;
}
