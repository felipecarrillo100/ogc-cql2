/**
 * The spatial test cases shared by the SQL tests: geometries (and values that aren't), how they are stored (GeoPackage
 * blobs, WKB, extended WKB), the literals and filters, and the comparison with `evaluate`. The literals lie on the
 * geometries' vertices and edges, inside holes, across the antimeridian, and on coordinates no 32-bit float holds.
 */
import type { Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { geosEngine } from "./geos-engine.ts";

// --- The geometries ------------------------------------------------------------------------------------------------

export type G = { type: string; coordinates?: unknown; geometries?: G[] };
export const square = (x: number, y: number, d: number) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];

/** Each row's value, as `evaluate` reads it; `"empty"` stands for an empty Point (GeoPackage's empty flag, or NaN). */
export const VALUES: (G | null | string | "empty")[] = [
  { type: "Point", coordinates: [1, 1] },
  { type: "Point", coordinates: [2, 0.5] }, // on the edge x = 2 of a box
  { type: "MultiPoint", coordinates: [[5, 5], [10, 10]] },
  { type: "LineString", coordinates: [[0, 3], [3, 3]] },
  { type: "MultiLineString", coordinates: [[[4, 0], [4, 4]], [[6, 6], [7, 7]]] },
  { type: "Polygon", coordinates: [square(0, 0, 8), square(2, 2, 4)] }, // with a hole
  { type: "MultiPolygon", coordinates: [[square(10, 10, 2)], [[[-180, -10], [-175, -10], [-175, 10], [-180, 10], [-180, -10]]]] },
  { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [20, 20] }, { type: "LineString", coordinates: [[20, 21], [22, 23]] }] },
  { type: "Point", coordinates: [3, 3, 100] }, // heights are ignored
  { type: "LineString", coordinates: [[175, 0], [179.5, 1]] },
  { type: "Polygon", coordinates: [[[30, 30], [40, 30], [35, 40], [30, 30]]] },
  { type: "Point", coordinates: [0.1, 0.7] }, // no 32-bit float holds 0.1 or 0.7: rounded, 0.1 grows, 0.7 shrinks
  "empty",
  { type: "GeometryCollection", geometries: [] },
  null,
  "POINT(1 1)", // text in a geometry column: not a geometry
];
export const GARBAGE = "garbage"; // bytes that aren't a geometry, a row of its own in the blob tables

// --- WKB and GeoPackage blobs, written here as a GeoPackage writer would -----------------------------------------

export function wkb(g: G | "empty", big = false, ewkb = false): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, v, !big);
    out.push(...new Uint8Array(b.buffer));
  };
  const f64 = (v: number) => {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v, !big);
    out.push(...new Uint8Array(b.buffer));
  };
  const write = (g: G | "empty", top: boolean) => {
    const geometry: G = g === "empty" ? { type: "Point", coordinates: [NaN, NaN] } : g;
    const codes: Record<string, number> = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 };
    const first = JSON.stringify(geometry.coordinates ?? []).match(/\[(-?[\d.e+-]+|null),(-?[\d.e+-]+|null),(-?[\d.e+-]+)\]/);
    const z = geometry.type === "Point" ? (geometry.coordinates as number[]).length === 3 : first !== null;
    out.push(big ? 0 : 1);
    const code = codes[geometry.type]!;
    if (ewkb) u32(code | (z ? 0x80000000 : 0) | (top ? 0x20000000 : 0));
    else u32(code + (z ? 1000 : 0));
    if (ewkb && top) u32(4326);
    const pos = (p: number[]) => [p[0]!, p[1]!, ...(z ? [p[2] ?? 0] : [])].forEach(f64);
    const list = (ps: number[][]) => (u32(ps.length), ps.forEach(pos));
    const c = geometry.coordinates as never;
    switch (geometry.type) {
      case "Point": return pos(c);
      case "LineString": return list(c);
      case "Polygon": return (u32((c as number[][][]).length), (c as number[][][]).forEach(list));
      case "MultiPoint": return (u32((c as number[][]).length), (c as number[][]).forEach((p) => write({ type: "Point", coordinates: p }, false)));
      case "MultiLineString": return (u32((c as number[][][]).length), (c as number[][][]).forEach((l) => write({ type: "LineString", coordinates: l }, false)));
      case "MultiPolygon": return (u32((c as number[][][][]).length), (c as number[][][][]).forEach((p) => write({ type: "Polygon", coordinates: p }, false)));
      default: return (u32(geometry.geometries!.length), geometry.geometries!.forEach((m) => write(m, false)));
    }
  };
  write(g, true);
  return new Uint8Array(out);
}

/** A geometry's envelope [minX, maxX, minY, maxY], GeoPackage's order; `undefined` when it is empty. */
export function envelopeOf(g: G | "empty"): number[] | undefined {
  if (g === "empty" || (g.type === "GeometryCollection" && g.geometries!.length === 0)) return undefined;
  const xs: number[] = [];
  const ys: number[] = [];
  JSON.stringify(g).replace(/\[(-?[\d.e+-]+),(-?[\d.e+-]+)(?:,[^\]]*)?\]/g, (_, x, y) => (xs.push(+x), ys.push(+y), ""));
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

/** A GeoPackage blob (GeoPackageBinary): the `GP` header, SRS 4326, with or without the envelope [minX, maxX, minY, maxY]. */
export function gpkg(g: G | "empty", withEnvelope: boolean): Uint8Array {
  const empty = envelopeOf(g) === undefined;
  const envelope = withEnvelope && !empty ? envelopeOf(g)! : [];
  const header = new DataView(new ArrayBuffer(8 + envelope.length * 8));
  header.setUint8(0, 0x47);
  header.setUint8(1, 0x50);
  header.setUint8(3, (envelope.length ? 1 << 1 : 0) | (empty ? 0x10 : 0) | 1);
  header.setInt32(4, 4326, true);
  envelope.forEach((v, i) => header.setFloat64(8 + i * 8, v, true));
  const body = wkb(g);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(new Uint8Array(header.buffer));
  out.set(body, header.byteLength);
  return out;
}

export const STORAGES: Record<string, (g: G | "empty") => Uint8Array> = {
  "GeoPackage, envelope": (g) => gpkg(g, true),
  "GeoPackage, no envelope": (g) => gpkg(g, false),
  "WKB": (g) => wkb(g),
  "extended WKB, big-endian": (g) => wkb(g, true, true),
};

/** A row's value in a blob table, and as `evaluate` reads it. */
export function stored(value: (typeof VALUES)[number] | typeof GARBAGE, storage: (g: G | "empty") => Uint8Array): unknown {
  if (value === null) return null;
  if (value === GARBAGE) return new Uint8Array([1, 2, 3, 4, 5]);
  if (typeof value === "string" && value !== "empty") return value;
  return storage(value as G | "empty");
}
export const asGeoJson = (value: (typeof VALUES)[number] | typeof GARBAGE): unknown =>
  value === "empty" ? { type: "Point", coordinates: [] } : value === GARBAGE ? "not a geometry" : value;

// --- The filters ---------------------------------------------------------------------------------------------------

export const LITERALS: unknown[] = [
  { bbox: [0, 0, 2, 2] }, // touches the point on x = 2
  { bbox: [8, 8, 9, 9] }, // touches the polygon's corner
  { bbox: [3, 3, 5, 5] }, // in the hole, touching a line's end and a point
  { bbox: [2.5, 2.5, 5.5, 5.5] }, // wholly in the hole
  { bbox: [170, -5, -170, 5] }, // across the antimeridian
  { bbox: [100, 50, 110, 60] }, // nothing
  { bbox: [0, 0, -5, 1, 1, 5] }, // heights left out
  { bbox: [-180, -90, 180, 90] },
  { bbox: [0.1, 0.7, 1, 1] }, // touches the point (0.1, 0.7) from the north-east
  { bbox: [-1, -1, 0.1, 0.7] }, // and from the south-west
  { type: "Point", coordinates: [8, 4] }, // on the polygon's edge
  { type: "Point", coordinates: [4, 4] }, // in the hole, on a line's end
  { type: "Point", coordinates: [1, 1] },
  { type: "Point", coordinates: [21, 22] }, // on the collection's line
  { type: "Point", coordinates: [0.1 + 0.2, 3] }, // on a line, after rounding
  { type: "Point", coordinates: [35, 35, 7] },
  { type: "LineString", coordinates: [[6, 6], [9, 9]] }, // through the hole's corner, along a line
  { type: "Polygon", coordinates: [[[2, 2], [6, 2], [4, 1], [2, 2]]] }, // sharing the hole's edge
  { type: "Polygon", coordinates: [square(4.5, 4.5, 6.5)] }, // containing a multipoint
  { type: "Polygon", coordinates: [square(31, 31, 1)] }, // inside the triangle
  { type: "MultiPoint", coordinates: [[100, 0], [7, 7]] },
  { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [100, 0] }, { type: "LineString", coordinates: [[20, 20], [19, 19]] }] },
];
export const leaf = (literal: unknown) => ({ op: "s_intersects", args: [{ property: "geometry" }, literal] });
export const FILTERS = [
  ...LITERALS.map(leaf),
  ...LITERALS.map((l) => ({ op: "not", args: [leaf(l)] })),
  ...LITERALS.map((l, i) => ({ op: "or", args: [leaf(l), { op: "not", args: [leaf(LITERALS[(i + 3) % LITERALS.length])] }] })),
  ...LITERALS.map((l, i) => ({ op: "and", args: [leaf(l), leaf(LITERALS[(i + 7) % LITERALS.length])] })),
  // Nested NOTs: a leaf under two is positive again, one under three isn't.
  ...LITERALS.map((l) => ({ op: "not", args: [{ op: "not", args: [leaf(l)] }] })),
  ...LITERALS.map((l, i) => ({ op: "not", args: [{ op: "or", args: [{ op: "not", args: [leaf(l)] }, { op: "not", args: [{ op: "not", args: [leaf(LITERALS[(i + 5) % LITERALS.length])] }] }] }] })),
] as unknown as Cql2Filter[];

/** The other relations of Spatial Functions, each literal as a leaf and under a NOT (S_DISJOINT included). */
export const RELATIONS = ["s_equals", "s_disjoint", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"] as const;
export const RELATION_FILTERS = RELATIONS.flatMap((op) => [
  ...LITERALS.map((l) => ({ op, args: [{ property: "geometry" }, l] })),
  ...LITERALS.map((l) => ({ op: "not", args: [{ op, args: [{ property: "geometry" }, l] }] })),
]) as unknown as Cql2Filter[];

/** The rows `evaluate` selects, with GEOS plugged in for the relations that need an engine. */
export const fromEvaluate = (values: unknown[], filter: Cql2Filter): number[] =>
  values.map((geometry, i) => ({ type: "Feature", id: i + 1, properties: {}, geometry })).filter(toPredicate(filter, { spatialEngine: geosEngine })).map((f) => f.id);

export function differences(run: (filter: Cql2Filter) => number[], values: unknown[], filters: readonly Cql2Filter[] = FILTERS): string {
  const out: string[] = [];
  for (const filter of filters) {
    const sql = run(filter);
    const memory = fromEvaluate(values, filter);
    if (JSON.stringify(sql) !== JSON.stringify(memory)) out.push(`${JSON.stringify(filter)}\n    sql ${JSON.stringify(sql)}  evaluate ${JSON.stringify(memory)}`);
  }
  return out.slice(0, 10).join("\n");
}

/** Every row of the blob tables. */
export const ALL = [...VALUES, GARBAGE];

// --- Property-Property Comparisons: a literal first, two geometry columns, two literals --------------------------

/** `op(a, b)` is `op'(b, a)` with S_WITHIN and S_CONTAINS exchanged (the others are symmetric). */
const CONVERSE: Record<string, string> = { s_within: "s_contains", s_contains: "s_within" };

/** A filter with each spatial leaf's literal first, the relation its converse: it selects the same rows. */
export function literalFirst(filter: unknown): unknown {
  if (Array.isArray(filter)) return filter.map(literalFirst);
  if (typeof filter !== "object" || filter === null || !("op" in filter)) return filter;
  const { op, args } = filter as { op: string; args: unknown[] };
  if (op.startsWith("s_") && "property" in (args[0] as object)) return { op: CONVERSE[op] ?? op, args: [args[1], args[0]] };
  return { op, args: args.map(literalFirst) };
}
export const LITERAL_FIRST = [...FILTERS, ...RELATION_FILTERS].map(literalFirst) as Cql2Filter[];

const g = { property: "geometry" };
const other = { property: "other" };
/** Every relation of two geometry columns, each way round, and under a NOT. */
export const PAIR_FILTERS = (["s_intersects", ...RELATIONS] as const).flatMap((op) => [
  { op, args: [g, other] }, { op, args: [other, g] }, { op: "not", args: [{ op, args: [g, other] }] },
]) as unknown as Cql2Filter[];
/** Every relation of two literals (eight pairs each): decided without a row. */
export const LITERAL_PAIRS = (["s_intersects", ...RELATIONS] as const).flatMap((op) =>
  LITERALS.slice(0, 8).map((l, i) => ({ op, args: [l, LITERALS[(i * 3 + 10) % LITERALS.length]] }))) as unknown as Cql2Filter[];

/** Rows of two geometries: every pair of `values`, the first `geometry`, the second `other`. */
export const pairsOf = <T>(values: readonly T[]): [T, T][] => values.flatMap((a) => values.map((b): [T, T] => [a, b]));

/** The rows `evaluate` selects among the pairs (GeoJSON, as `asGeoJson` gives them), with GEOS plugged in. */
export const fromEvaluatePairs = (pairs: readonly [unknown, unknown][], filter: Cql2Filter): number[] =>
  pairs.map(([a, b], i) => ({ type: "Feature", id: i + 1, properties: { other: b }, geometry: a }))
    .filter(toPredicate(filter, { spatialEngine: geosEngine })).map((f) => f.id);

export function pairDifferences(run: (filter: Cql2Filter) => number[], pairs: readonly [unknown, unknown][], filters: readonly Cql2Filter[]): string {
  const out: string[] = [];
  for (const filter of filters) {
    const sql = run(filter);
    const memory = fromEvaluatePairs(pairs, filter);
    if (JSON.stringify(sql) !== JSON.stringify(memory)) out.push(`${JSON.stringify(filter)}\n    sql ${JSON.stringify(sql)}  evaluate ${JSON.stringify(memory)}`);
  }
  return out.slice(0, 10).join("\n");
}
