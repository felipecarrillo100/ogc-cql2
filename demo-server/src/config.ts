/**
 * `collections.json`: which collections the server serves, and from where.
 *
 * ```json
 * { "collections": [{ "id": "states", "title": "US states", "source": "geojson", "file": "data/states.geojson" }] }
 * ```
 * Files are relative to the directory of `collections.json`. Only `geojson` exists so far; `sqlite` and `postgres`
 * come later.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface CollectionConfig {
  readonly id: string;
  readonly title: string;
  readonly source: "geojson";
  /** Absolute path of the data file. */
  readonly file: string;
}

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
    if (typeof entry.id !== "string" || !ID.test(entry.id)) {
      problems.push(`${where}: "id" must use letters, digits, "_" or "-".`);
      return;
    }
    if (seen.has(entry.id)) problems.push(`${where}: the id "${entry.id}" is used twice.`);
    seen.add(entry.id);
    if (entry.source !== "geojson") {
      problems.push(`${where}: source "${String(entry.source)}" is not supported (yet); use "geojson".`);
      return;
    }
    if (typeof entry.file !== "string") {
      problems.push(`${where}: "file" must be the path of a GeoJSON file.`);
      return;
    }
    out.push({
      id: entry.id,
      title: typeof entry.title === "string" ? entry.title : entry.id,
      source: "geojson",
      file: resolve(dirname(path), entry.file),
    });
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return out;
}
