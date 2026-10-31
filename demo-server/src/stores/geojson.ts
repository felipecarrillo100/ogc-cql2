/**
 * A collection read from one GeoJSON FeatureCollection file, filtered in memory with `ogc-cql2/evaluate`.
 *
 * The file is read once, when the server starts, and never written. Ids follow the rules agreed for the demo:
 * - a feature's own id (a string or a number, RFC 7946 §3.2) is kept, when it is unique;
 * - a feature without one gets a generated id, deterministically: its position in the file (1, 2, 3…), or, when
 *   other features have numeric ids, the next numbers after the largest of them. So ids stay the same across
 *   queries and restarts until the file changes;
 * - an id that is already taken is a data error: the first feature keeps it, every later one is dropped, and that is
 *   reported (the startup log and the collection's `warnings`);
 * - `1` and `"1"` are different ids, as GeoJSON has it.
 */
import { readFileSync } from "node:fs";
import { CONFORMANCE } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { geosEngine } from "../geos-engine.ts";
import { BASE_CLASSES, type CollectionDescription, type Feature, type FeatureId, type Queryable, type Store } from "./types.ts";

export interface GeoJsonCollection {
  readonly id: string;
  readonly title: string;
}

// RFC 7946 dropped `crs`; files from before it may still name CRS84, which is RFC 7946's own CRS.
const CRS84 = new Set(["urn:ogc:def:crs:OGC:1.3:CRS84", "urn:ogc:def:crs:OGC::CRS84", "http://www.opengis.net/def/crs/OGC/1.3/CRS84"]);

const isId = (x: unknown): x is FeatureId => typeof x === "string" || (typeof x === "number" && Number.isFinite(x));
const idKey = (id: FeatureId): string => `${typeof id}:${id}`;

/** The features with their final ids, and what had to be reported. Throws for a file that can't be served. */
export function prepareFeatures(json: unknown, name: string): { features: Feature[]; warnings: string[] } {
  const collection = json as { type?: unknown; crs?: { properties?: { name?: unknown } }; features?: unknown };
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error(`${name} is not a GeoJSON FeatureCollection.`);
  }
  if (collection.crs !== undefined) {
    const crs = collection.crs?.properties?.name;
    if (typeof crs !== "string" || !CRS84.has(crs)) {
      throw new Error(`${name} declares the CRS ${JSON.stringify(crs)}; only WGS 84 longitude, latitude (CRS84) is supported, as in RFC 7946.`);
    }
  }
  const raw = collection.features as Record<string, unknown>[];
  const warnings: string[] = [];

  // Ids the file gives, in file order; the first feature with an id keeps it.
  const owner = new Map<string, number>();
  const dropped: string[] = [];
  const keep: boolean[] = raw.map((feature, i) => {
    if (!isId(feature.id)) return true;
    const key = idKey(feature.id);
    const first = owner.get(key);
    if (first === undefined) {
      owner.set(key, i);
      return true;
    }
    dropped.push(`feature ${i + 1} (id ${JSON.stringify(feature.id)}, already used by feature ${first + 1})`);
    return false;
  });
  if (dropped.length > 0) warnings.push(`Dropped ${dropped.length} feature(s) with a duplicate id: ${dropped.join("; ")}.`);

  const invalidIds = raw.filter((f) => f.id !== undefined && f.id !== null && !isId(f.id)).length;
  if (invalidIds > 0) warnings.push(`${invalidIds} feature(s) had an id that is neither a string nor a number; they get generated ids.`);

  const numericIds = raw.filter((f, i) => keep[i] && typeof f.id === "number").map((f) => f.id as number);
  let next = numericIds.length > 0 ? Math.floor(Math.max(...numericIds)) + 1 : undefined;
  let generated = 0;

  const features: Feature[] = [];
  raw.forEach((feature, i) => {
    if (!keep[i]) return;
    let id: FeatureId;
    if (isId(feature.id)) {
      id = feature.id;
    } else {
      generated++;
      id = next === undefined ? i + 1 : next++;
    }
    const properties = feature.properties;
    features.push({
      type: "Feature",
      id,
      geometry: feature.geometry ?? null,
      properties: typeof properties === "object" && properties !== null && !Array.isArray(properties) ? (properties as Record<string, unknown>) : {},
    });
  });
  if (generated > 0) {
    const how = numericIds.length > 0 ? `numbers after the largest numeric id` : "their position in the file";
    warnings.push(`Generated ids for ${generated} feature(s) without one: ${how}.`);
  }
  return { features, warnings };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** The queryables, from the values the features hold: each property's type, and its format for dates and instants. */
export function inferQueryables(features: readonly Feature[]): { queryables: Record<string, Queryable>; warnings: string[] } {
  const kinds = new Map<string, Set<string>>();
  for (const feature of features) {
    for (const [name, value] of Object.entries(feature.properties)) {
      const set = kinds.get(name) ?? new Set<string>();
      kinds.set(name, set);
      if (value === null || value === undefined) continue;
      if (typeof value === "string") set.add(DATE.test(value) ? "date" : INSTANT.test(value) ? "date-time" : "string");
      else if (typeof value === "number") set.add(Number.isInteger(value) ? "integer" : "number");
      else if (typeof value === "boolean") set.add("boolean");
      else set.add(Array.isArray(value) ? "array" : "object");
    }
  }
  const queryables: Record<string, Queryable> = {};
  const warnings: string[] = [];
  for (const [name, set] of kinds) {
    const k = [...set];
    if (k.length === 0) {
      queryables[name] = {};
    } else if (k.every((x) => x === "integer")) {
      queryables[name] = { type: "integer" };
    } else if (k.every((x) => x === "integer" || x === "number")) {
      queryables[name] = { type: "number" };
    } else if (k.length === 1 && k[0] === "boolean") {
      queryables[name] = { type: "boolean" };
    } else if (k.length === 1 && (k[0] === "date" || k[0] === "date-time")) {
      queryables[name] = { type: "string", format: k[0] };
    } else if (k.every((x) => x === "string" || x === "date" || x === "date-time")) {
      queryables[name] = { type: "string" };
    } else {
      queryables[name] = {};
      warnings.push(`Property "${name}" holds values of mixed types (${k.join(", ")}); comparisons are NULL where the type doesn't match.`);
    }
  }
  return { queryables, warnings };
}

/** A store over already parsed GeoJSON. */
export function createGeoJsonStore(collection: GeoJsonCollection, json: unknown, name = collection.id): Store {
  const { features, warnings: idWarnings } = prepareFeatures(json, name);
  const { queryables, warnings: typeWarnings } = inferQueryables(features);
  const description: CollectionDescription = {
    id: collection.id,
    title: collection.title,
    source: "geojson",
    featureCount: features.length,
    warnings: [...idWarnings, ...typeWarnings],
  };
  return {
    describe: () => description,
    queryables: () => queryables,
    hasGeometry: () => true, // every GeoJSON feature has a geometry member, maybe null
    conformance: () => [...BASE_CLASSES, CONFORMANCE.spatial], // the other relations through GEOS (geos.js)
    async query(filter, { limit, offset }) {
      const matched = features.filter(toPredicate(filter, { spatialEngine: geosEngine }));
      return { features: matched.slice(offset, offset + limit), numberMatched: matched.length };
    },
  };
}

/** A store over a GeoJSON file, read now. */
export function loadGeoJsonStore(collection: GeoJsonCollection, file: string): Store {
  return createGeoJsonStore(collection, JSON.parse(readFileSync(file, "utf8")), file);
}
