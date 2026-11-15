/**
 * What a queryable says a property holds: for `validate`'s type checks, and for `evaluate`, which reads two
 * properties compared with each other as their queryables say. Internal to the package.
 */
import type { Queryable } from "./types.js";

/** What a queryable holds; `any` when it doesn't say. */
export type HeldKind = "text" | "date" | "instant" | "number" | "boolean" | "geometry" | "other" | "any";

export function heldKind(q: Queryable): HeldKind {
  // OGC API Features Part 3 describes a geometry queryable by a format (`geometry-point`, `geometry-any`…) or by a
  // reference to a GeoJSON schema.
  if (typeof q.format === "string" && q.format.startsWith("geometry-")) return "geometry";
  const ref = (q as { $ref?: unknown }).$ref;
  if (typeof ref === "string" && /geojson\.org\/schema\//.test(ref)) return "geometry";
  // JSON Schema allows a list of types: a nullable property is ["string", "null"]. NULL is always possible in CQL2.
  const types: unknown = Array.isArray(q.type) ? q.type.filter((t) => t !== "null") : q.type;
  const type = Array.isArray(types) ? (types.length === 1 ? types[0] : undefined) : types;
  if (type === undefined) return q.format === "date" ? "date" : q.format === "date-time" ? "instant" : "any";
  if (type === "string") return q.format === "date" ? "date" : q.format === "date-time" ? "instant" : "text";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  return "other";
}

/**
 * What an array queryable's elements hold (its `items`; `any` without them), for the array functions; `not-array`
 * for a queryable that isn't an array.
 */
export function itemsKind(q: Queryable): HeldKind | "not-array" {
  const types: unknown = Array.isArray(q.type) ? q.type.filter((t) => t !== "null") : q.type;
  const type = Array.isArray(types) ? (types.length === 1 ? types[0] : undefined) : types;
  if (type !== "array") return "not-array";
  return typeof q.items === "object" && q.items !== null ? heldKind(q.items) : "any";
}
