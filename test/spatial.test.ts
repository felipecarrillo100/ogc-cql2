/**
 * `evaluate`, S_INTERSECTS: planar, boundaries included, as Simple Features and GEOS define it; heights ignored.
 * The cases each engine must decide the same way: on an edge, in a hole, touching at a vertex, along an edge,
 * containment without crossing, collections, boxes across the antimeridian. The differential test against PostGIS is
 * in demo-server/test/spatial.test.ts; the standard's own Natural Earth test in test/naturalearth.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { evaluate } from "ogc-cql2/evaluate";

const square = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const polygon = (...rings: number[][][]) => ({ type: "Polygon", coordinates: rings });
const point = (x: number, y: number, z?: number) => ({ type: "Point", coordinates: z === undefined ? [x, y] : [x, y, z] });
const line = (...ps: number[][]) => ({ type: "LineString", coordinates: ps });

/** S_INTERSECTS(geometry, literal) on a feature whose geometry is `geometry`. */
const meets = (geometry: unknown, literal: unknown) =>
  evaluate({ op: "s_intersects", args: [{ property: "geometry" }, literal] } as Cql2Filter, { type: "Feature", properties: {}, geometry });

const withHole = polygon(square(0, 0, 10, 10), square(4, 4, 6, 6));

describe("S_INTERSECTS: points and polygons", () => {
  it.each([
    ["inside", point(1, 1), true],
    ["on an edge", point(10, 5), true],
    ["on a corner", point(10, 10), true],
    ["outside", point(11, 5), false],
    ["in the hole", point(5, 5), false],
    ["on the hole's edge", point(4, 5), true],
    ["just outside, by a hair", point(10 + 1e-12, 5), false],
  ])("a point %s", (_, p, expected) => {
    expect(meets(withHole, p)).toBe(expected);
    expect(meets(p, withHole)).toBe(expected); // symmetric
  });

  it("decided exactly: points that a plain floating-point test puts on a line, but aren't (as PostGIS decides)", () => {
    // Found by search: the naive orientation is 0 for these, the exact one isn't; PostGIS agrees with the exact one.
    const a1 = [-94.03525202997778, 33.20502333853904], b1 = [-90.90271337719078, 35.849182826111964];
    const c1 = point(-93.68129395397237, 33.50379749860889);
    expect(meets(line(a1, b1), c1)).toBe(false);
    expect(meets(polygon([a1, b1, [a1[0]! - 1, a1[1]! + 1], a1]), c1)).toBe(false); // just outside the triangle
    const a2 = [-99.42375842983093, 37.574333100300365], b2 = [-94.17533117237825, 35.245388535325716];
    const c2 = point(-96.65011712884578, 36.34355357030955);
    expect(meets(line(a2, b2), c2)).toBe(false);
    expect(meets(polygon([a2, b2, [a2[0]! - 1, a2[1]! + 1], a2]), c2)).toBe(true); // just inside it
  });

  it("an edge that isn't axis-aligned: the exact midpoint is on it", () => {
    const triangle = polygon([[0, 0], [3, 1], [0, 2], [0, 0]]);
    expect(meets(triangle, point(1.5, 0.5))).toBe(true); // on the edge (0,0)–(3,1)
    expect(meets(triangle, point(1.5, 0.5 - 1e-15))).toBe(false); // just below it
  });
});

describe("S_INTERSECTS: lines", () => {
  const box = polygon(square(0, 0, 10, 10));
  it.each([
    ["crossing", line([-1, 5], [11, 5]), true],
    ["touching a vertex", line([10, 10], [12, 12]), true],
    ["along an edge", line([10, 2], [10, 8]), true],
    ["inside, without crossing", line([2, 2], [3, 3]), true],
    ["outside", line([11, 0], [11, 10]), false],
    ["in the hole, without touching it", line([4.5, 4.5], [5.5, 5.5]), "hole"],
  ])("a line %s", (_, l, expected) => {
    if (expected === "hole") return expect(meets(withHole, l)).toBe(false);
    expect(meets(box, l)).toBe(expected);
  });

  it("two lines: crossing, collinear overlapping, collinear apart, sharing an endpoint, parallel", () => {
    expect(meets(line([0, 0], [2, 2]), line([0, 2], [2, 0]))).toBe(true);
    expect(meets(line([0, 0], [2, 0]), line([1, 0], [3, 0]))).toBe(true);
    expect(meets(line([0, 0], [1, 0]), line([2, 0], [3, 0]))).toBe(false);
    expect(meets(line([0, 0], [1, 1]), line([1, 1], [2, 0]))).toBe(true);
    expect(meets(line([0, 0], [1, 0]), line([0, 1], [1, 1]))).toBe(false);
  });
});

describe("S_INTERSECTS: polygons", () => {
  it("overlapping, touching at a corner or along an edge, one inside the other, one in the other's hole, apart", () => {
    const a = polygon(square(0, 0, 10, 10));
    expect(meets(a, polygon(square(5, 5, 15, 15)))).toBe(true);
    expect(meets(a, polygon(square(10, 10, 20, 20)))).toBe(true);
    expect(meets(a, polygon(square(10, 0, 20, 10)))).toBe(true);
    expect(meets(a, polygon(square(2, 2, 3, 3)))).toBe(true); // inside, no edge crosses
    expect(meets(polygon(square(2, 2, 3, 3)), a)).toBe(true); // containing
    expect(meets(withHole, polygon(square(4.5, 4.5, 5.5, 5.5)))).toBe(false); // in the hole
    expect(meets(a, polygon(square(11, 11, 12, 12)))).toBe(false);
  });
});

describe("S_INTERSECTS: boxes, collections, heights, and what isn't a geometry", () => {
  it("a box; a box across the antimeridian is two boxes", () => {
    expect(meets(point(5, 45), { bbox: [0, 40, 10, 50] })).toBe(true);
    expect(meets(point(175, 0), { bbox: [170, -10, -170, 10] })).toBe(true);
    expect(meets(point(-175, 0), { bbox: [170, -10, -170, 10] })).toBe(true);
    expect(meets(point(0, 0), { bbox: [170, -10, -170, 10] })).toBe(false);
    expect(meets(point(5, 45), { bbox: [0, 40, -100, 10, 50, 100] })).toBe(true); // 6 numbers: heights ignored
  });

  it("multi-geometries and collections: any member", () => {
    const multi = { type: "MultiPoint", coordinates: [[50, 50], [5, 5]] };
    expect(meets(multi, { bbox: [0, 0, 10, 10] })).toBe(true);
    const collection = { type: "GeometryCollection", geometries: [point(50, 50), line([20, 20], [30, 30])] };
    expect(meets(collection, { bbox: [0, 0, 10, 10] })).toBe(false);
    expect(meets(collection, { bbox: [25, 25, 26, 26] })).toBe(true);
    expect(meets({ type: "MultiPolygon", coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] }, point(5.5, 5.5))).toBe(true);
  });

  it("heights are ignored (2D): a point 500 m up still lies over the area", () => {
    expect(meets(point(5, 5, 500), polygon(square(0, 0, 10, 10)))).toBe(true);
  });

  it("no geometry is NULL; something that isn't a GeoJSON geometry is NULL (a type mismatch)", () => {
    expect(meets(null, { bbox: [0, 0, 1, 1] })).toBe(null);
    expect(meets(undefined, { bbox: [0, 0, 1, 1] })).toBe(null);
    expect(meets({ type: "Point", coordinates: ["a", 1] }, { bbox: [0, 0, 1, 1] })).toBe(null);
    expect(meets("POINT(0 0)", { bbox: [0, 0, 1, 1] })).toBe(null);
    expect(meets({ type: "MultiPolygon", coordinates: [] }, { bbox: [0, 0, 1, 1] })).toBe(false); // empty: nothing to meet
    expect(meets({ type: "Point", coordinates: [] }, { bbox: [0, 0, 1, 1] })).toBe(false); // an empty Point, as GDAL writes it
  });

  it("geometryProperty and getProperty: where the geometry is read", () => {
    const filter = { op: "s_intersects", args: [{ property: "where" }, { bbox: [0, 0, 1, 1] }] } as Cql2Filter;
    const f = { type: "Feature", geometry: point(9, 9), properties: { where: point(0.5, 0.5) } };
    expect(evaluate(filter, f)).toBe(true); // a property holding a geometry
    expect(evaluate(filter, f, { geometryProperty: "where" })).toBe(false); // now `where` means feature.geometry
    const plain = { shape: point(0.5, 0.5) };
    expect(evaluate(filter, plain, { getProperty: (x, name) => (name === "where" ? x.shape : undefined) })).toBe(true);
  });
});
