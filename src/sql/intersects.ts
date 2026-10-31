/**
 * S_INTERSECTS as a function the SQL engine calls: a stored geometry (GeoPackage blob or WKB) against the filter's
 * literal (as JSON text), decided by `evaluate`'s own engine, so exactly as `evaluate` decides it. Shared by the
 * `sqlite` and `duckdb` dialects' registered functions. Internal to the package.
 */
import type { SpatialLiteral } from "../core/types.js";
import { geometryParts, intersects, literalParts } from "../evaluate/spatial.js";
import { gpkgEnvelope, readStoredGeometry } from "./wkb.js";

type Parts = ReturnType<typeof literalParts>;
const literals = new Map<string, Parts>();

let last: { json: string; parts: Parts } | undefined;

function literalOf(json: string): Parts {
  // The engine passes the same literal for every row: compared as text first, it isn't hashed again per row.
  if (last?.json === json) return last.parts;
  let parts = literals.get(json);
  if (!parts) {
    parts = literalParts(JSON.parse(json) as SpatialLiteral);
    if (literals.size > 1000) literals.clear();
    literals.set(json, parts);
  }
  last = { json, parts };
  return parts;
}

/** 1 if the stored geometry intersects the literal, 0 if not (or empty), NULL for NULL or bytes that aren't a geometry. */
export function intersectsStored(value: unknown, literal: unknown): number | null {
  if (!(value instanceof Uint8Array) || typeof literal !== "string") return null;
  const target = literalOf(literal);
  // A GeoPackage blob's header envelope rejects most rows before the WKB is decoded.
  const envelope = gpkgEnvelope(value);
  if (envelope === "empty") return 0;
  const box = target.box;
  if (envelope && box && (envelope[2] < box[0] || box[2] < envelope[0] || envelope[3] < box[1] || box[3] < envelope[1])) return 0;
  const stored = readStoredGeometry(value);
  if (stored === undefined) return null;
  if (stored === null) return 0;
  const parts = geometryParts(stored);
  return parts === undefined ? null : intersects(parts, target) ? 1 : 0;
}
