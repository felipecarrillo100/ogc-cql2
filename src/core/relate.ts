/**
 * The spatial relations as DE-9IM patterns: what each CQL2 spatial function means, in one place. CQL2 1.0.0 evaluates
 * them "as defined in clause 6.1.15 of OGC Simple Feature Access - Part 1" (Requirement 11), from the intersection
 * matrix of the two geometries' interiors, boundaries and exteriors. Internal to the package.
 *
 * A matrix is nine characters, row by row: I(a)∩I(b), I(a)∩B(b), I(a)∩E(b), B(a)∩I(b) … E(a)∩E(b), each `F` (empty)
 * or the dimension of the intersection, `0`, `1` or `2`.
 */
import type { Geometry, SpatialLiteral } from "./types.js";

/** The relations decided from a matrix; S_INTERSECTS and S_DISJOINT have an exact engine of their own. */
export type MatrixRelation = "s_equals" | "s_touches" | "s_within" | "s_overlaps" | "s_crosses" | "s_contains";

/** Whether a matrix matches a pattern: `T` any dimension, `F` empty, `*` anything, a digit that dimension. */
function match(matrix: string, pattern: string): boolean {
  for (let i = 0; i < 9; i++) {
    const p = pattern[i]!;
    const m = matrix[i]!;
    if (p === "*") continue;
    if (p === "T" ? m === "F" : p !== m) return false;
  }
  return true;
}

/**
 * Whether `a` and `b` are in the relation, from their matrix (a first) and their dimensions (0 points, 1 lines,
 * 2 areas; a collection's is its highest member's). The patterns are Simple Features'. CQL2's Table 4 gives the
 * second of S_TOUCHES as `F**F*****`, a typo for Simple Features' `F**T*****` (PostGIS and GEOS use it too).
 */
export function relates(relation: MatrixRelation, matrix: string, dimA: number, dimB: number): boolean {
  switch (relation) {
    case "s_equals":
      return match(matrix, "T*F**FFF*");
    case "s_touches":
      return match(matrix, "FT*******") || match(matrix, "F**T*****") || match(matrix, "F***T****");
    case "s_within":
      return match(matrix, "T*F**F***");
    case "s_contains":
      return match(matrix, "T*****FF*");
    case "s_overlaps":
      // Only for two geometries of the same dimension: two lines meet in a line, two points or two areas in their own.
      if (dimA !== dimB) return false;
      return match(matrix, dimA === 1 ? "1*T***T**" : "T*T***T**");
    case "s_crosses":
      // A point set with a line or area, a line with an area (and the other way round), or two lines meeting in points.
      if (dimA < dimB) return match(matrix, "T*T******");
      if (dimA > dimB) return match(matrix, "T*****T**");
      return dimA === 1 && match(matrix, "0********");
  }
}

/** The matrix of (b, a) from that of (a, b). */
export function transpose(matrix: string): string {
  return [0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => matrix[i]).join("");
}

/** A geometry's dimension: 0 points, 1 lines, 2 areas; a collection's is its highest member's (−1 when it has none). */
export function dimension(g: Geometry): number {
  switch (g.type) {
    case "Point":
    case "MultiPoint":
      return 0;
    case "LineString":
    case "MultiLineString":
      return 1;
    case "Polygon":
    case "MultiPolygon":
      return 2;
    case "GeometryCollection":
      return Math.max(-1, ...g.geometries.map(dimension));
  }
}

/** A literal as a geometry: a box as a polygon, across the antimeridian (west > east) two, as a MultiPolygon. */
export function literalGeometry(x: SpatialLiteral): Geometry {
  if (!("bbox" in x) || "type" in x) return x as Geometry;
  const b = x.bbox;
  const [west, south, east, north] = b.length === 4 ? b : [b[0], b[1], b[3], b[4]];
  const ring = (w: number, e: number) => [[w, south], [e, south], [e, north], [w, north], [w, south]] as [number, number][];
  return west > east
    ? { type: "MultiPolygon", coordinates: [[ring(west, 180)], [ring(-180, east)]] }
    : { type: "Polygon", coordinates: [ring(west, east)] };
}
