/**
 * `evaluate` with a spatial engine (`spatialEngine`): the Spatial Functions class. The package decides the meaning
 * (patterns, dimension rules, transposition) from the engine's matrix; GEOS's own predicates are the reference, on
 * geometries made to sit on each other's vertices and edges, inside holes, and in collections. A fake engine checks
 * what the package handles itself: NULLs, values that aren't a geometry, empty geometries, an engine's errors.
 */
import * as geos from "geos.js";
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { evaluate, toEvaluator, type SpatialEngine } from "ogc-cql2/evaluate";
import { validate } from "ogc-cql2/validate";
import { geosEngine } from "./geos-engine.ts";

type G = { type: string; coordinates?: unknown; geometries?: G[] };
const sq = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const P = (x: number, y: number): G => ({ type: "Point", coordinates: [x, y] });
const L = (...c: number[][]): G => ({ type: "LineString", coordinates: c });
const A = (...r: number[][][]): G => ({ type: "Polygon", coordinates: r });

/** Geometries made to sit on each other: vertices, edges, holes, shared and collinear edges, collections. */
const GEOMETRIES: Record<string, G> = {
  pIn: P(1, 1), pEdge: P(2, 1), pVert: P(2, 2), pOut: P(5, 5), pHole: P(1.5, 1.5), pHoleEdge: P(1.25, 1.5),
  mp: { type: "MultiPoint", coordinates: [[1, 1], [5, 5]] }, mpOn: { type: "MultiPoint", coordinates: [[0, 0], [2, 1]] },
  lEdge: L([0, 0], [2, 0]), lHalfEdge: L([0.5, 0], [1.5, 0]), lIn: L([0.5, 0.5], [0.5, 1.5]), lCross: L([-1, 1], [3, 1]),
  lTouch: L([2, 1], [3, 1]), lOut: L([3, 3], [4, 4]), lDiag: L([0, 0], [2, 2]), lDiag2: L([0, 2], [2, 0]),
  lCollinear: L([1, 0], [3, 0]), lRing: L([0, 0], [2, 0], [2, 2], [0, 0]),
  mlEdge: { type: "MultiLineString", coordinates: [[[0, 0], [2, 0]], [[2, 0], [2, 2]]] },
  sq: A(sq(0, 0, 2, 2)), sqReversed: A([[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]), sqShifted: A([[2, 0], [2, 2], [0, 2], [0, 0], [2, 0]]),
  sqExtraVertex: A([[0, 0], [1, 0], [2, 0], [2, 2], [0, 2], [0, 0]]), sqOverlapping: A(sq(1, 1, 3, 3)), sqTouchingEdge: A(sq(2, 0, 4, 2)),
  sqTouchingVertex: A(sq(2, 2, 4, 4)), sqInside: A(sq(0.5, 0.5, 1, 1)), sqInsideTouching: A(sq(0, 0, 1, 1)), sqBig: A(sq(-1, -1, 3, 3)),
  sqHole: A(sq(0, 0, 2, 2), sq(1.25, 1.25, 1.75, 1.75)), plug: A(sq(1.25, 1.25, 1.75, 1.75)), sqFar: A(sq(10, 10, 11, 11)),
  mpoly: { type: "MultiPolygon", coordinates: [[sq(0, 0, 1, 1)], [sq(1, 1, 2, 2)]] },
  gcPointArea: { type: "GeometryCollection", geometries: [P(1, 1), A(sq(3, 3, 4, 4))] },
  gcLinePoint: { type: "GeometryCollection", geometries: [L([0, 0], [2, 0]), P(1, 1)] },
  gcAreas: { type: "GeometryCollection", geometries: [A(sq(0, 0, 1, 2)), A(sq(1.5, 0, 2, 2))] },
};

const RELATIONS = ["s_equals", "s_disjoint", "s_intersects", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"] as const;
const GEOS_PREDICATE: Record<(typeof RELATIONS)[number], (a: geos.Geometry, b: geos.Geometry) => boolean> = {
  s_equals: geos.equals, s_disjoint: geos.disjoint, s_intersects: geos.intersects, s_touches: geos.touches,
  s_within: geos.within, s_overlaps: geos.overlaps, s_crosses: geos.crosses, s_contains: geos.contains,
};
const filter = (op: string, literal: unknown) => ({ op, args: [{ property: "geometry" }, literal] }) as unknown as Cql2Filter;
const feature = (geometry: unknown) => ({ type: "Feature", properties: {}, geometry });

describe("evaluate with GEOS plugged in: the same answers as GEOS's own predicates", () => {
  const names = Object.keys(GEOMETRIES);
  const literals = names.filter((n) => validate(filter("s_within", GEOMETRIES[n])).valid);

  it("the literals are the valid ones (a collection holds two or more geometries)", () => {
    expect(literals.length).toBe(names.length);
  });

  it(`${RELATIONS.length} relations × ${names.length} features × ${names.length} literals`, () => {
    const differences: string[] = [];
    let trues = 0;
    for (const relation of RELATIONS) {
      for (const l of literals) {
        const test = toEvaluator(filter(relation, GEOMETRIES[l]), { spatialEngine: geosEngine });
        for (const f of names) {
          const ours = test(feature(GEOMETRIES[f]));
          const theirs = GEOS_PREDICATE[relation](geos.fromGeoJSON(GEOMETRIES[f] as never), geos.fromGeoJSON(GEOMETRIES[l] as never));
          if (ours) trues++;
          if (ours !== theirs) differences.push(`${relation}(${f}, ${l}): evaluate ${ours}, GEOS ${theirs}`);
        }
      }
    }
    expect(differences.slice(0, 10).join("\n")).toBe("");
    expect(trues).toBeGreaterThan(1000); // not a trivial test
  });
});

describe("what the package handles itself", () => {
  const square = { type: "Polygon", coordinates: [sq(0, 0, 2, 2)] };
  /** An engine that answers one fixed matrix (the literal first), or throws. */
  const fixed = (matrix: string | Error): SpatialEngine & { calls: number } => {
    const engine = {
      calls: 0,
      prepare: () => ({
        relate: () => {
          engine.calls++;
          if (matrix instanceof Error) throw matrix;
          return matrix;
        },
      }),
    };
    return engine;
  };

  it("without an engine the Spatial Functions class is refused, S_DISJOINT included", () => {
    for (const relation of ["s_within", "s_disjoint"]) {
      expect(() => evaluate(filter(relation, square), feature(square))).toThrow(
        expect.objectContaining({ code: "unsupported", details: { conformance: "http://www.opengis.net/spec/cql2/1.0/conf/spatial-functions" } }),
      );
    }
  });

  it("the engine's matrix is the literal's first: transposed before matching", () => {
    // (literal, geometry) = the literal inside the geometry: the geometry contains the literal, isn't within it.
    const engine = fixed("2FF1FF212");
    expect(evaluate(filter("s_contains", square), feature(square), { spatialEngine: engine })).toBe(true);
    expect(evaluate(filter("s_within", square), feature(square), { spatialEngine: engine })).toBe(false);
  });

  it("NULL, a value that isn't a geometry, an empty geometry: never sent to the engine", () => {
    const engine = fixed("2FFF1FFF2");
    const o = { spatialEngine: engine };
    expect(evaluate(filter("s_equals", square), feature(null), o)).toBe(null);
    expect(evaluate(filter("s_equals", square), feature("POINT(1 1)"), o)).toBe(null);
    expect(evaluate(filter("s_equals", square), feature({ type: "Point", coordinates: "x" }), o)).toBe(null);
    for (const empty of [{ type: "Point", coordinates: [] }, { type: "GeometryCollection", geometries: [] }]) {
      for (const relation of ["s_equals", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"]) {
        expect(evaluate(filter(relation, square), feature(empty), o)).toBe(false);
      }
      expect(evaluate(filter("s_disjoint", square), feature(empty), o)).toBe(true);
    }
    expect(engine.calls).toBe(0);
  });

  it("an engine that throws for a feature: NULL for it, so NOT doesn't select it either", () => {
    const engine = fixed(new Error("invalid polygon"));
    expect(evaluate(filter("s_within", square), feature(square), { spatialEngine: engine })).toBe(null);
    expect(evaluate({ op: "not", args: [filter("s_within", square)] } as unknown as Cql2Filter, feature(square), { spatialEngine: engine })).toBe(null);
  });

  it("S_INTERSECTS and S_DISJOINT use the package's own engine, with or without one plugged in", () => {
    const engine = fixed("FFFFFFFF2"); // would say disjoint
    expect(evaluate(filter("s_intersects", square), feature(square), { spatialEngine: engine })).toBe(true);
    expect(evaluate(filter("s_disjoint", square), feature(square), { spatialEngine: engine })).toBe(false);
    expect(engine.calls).toBe(0);
  });

  it("a box is a polygon, across the antimeridian a MultiPolygon of the two halves", () => {
    const seen: unknown[] = [];
    const engine: SpatialEngine = { prepare: (l) => (seen.push(l), { relate: () => "FFFFFFFF2" }) };
    evaluate(filter("s_within", { bbox: [0, 1, 2, 3] }), feature(square), { spatialEngine: engine });
    evaluate(filter("s_within", { bbox: [170, -5, -170, 5] }), feature(square), { spatialEngine: engine });
    expect(seen).toEqual([
      { type: "Polygon", coordinates: [[[0, 1], [2, 1], [2, 3], [0, 3], [0, 1]]] },
      { type: "MultiPolygon", coordinates: [[[[170, -5], [180, -5], [180, 5], [170, 5], [170, -5]]], [[[-180, -5], [-170, -5], [-170, 5], [-180, 5], [-180, -5]]]] },
    ]);
  });
});
