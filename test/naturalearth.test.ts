/**
 * The standard's own acceptance tests, on Natural Earth 1:110m (test/fixtures/naturalearth/, public domain): the
 * predicates and the number of features each must select, for Basic Spatial Functions (OGC 21-065r2, Annex A.7,
 * conformance test 26, Table 12) and for Spatial Functions (Annex A.9.9, conformance test 38, Table 14, with GEOS
 * plugged in as the engine). Each filter is written back as CQL2-text to check it is the standard's own predicate.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { toText } from "ogc-cql2/text";
import { geosEngine } from "./geos-engine.ts";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/naturalearth/${name}.geojson`, import.meta.url), "utf8")).features as unknown[];
const DATA: Record<string, unknown[]> = {
  ne_110m_admin_0_countries: read("ne_110m_admin_0_countries"),
  ne_110m_populated_places_simple: read("ne_110m_populated_places_simple"),
  ne_110m_rivers_lake_centerlines: read("ne_110m_rivers_lake_centerlines"),
};

const geom = { property: "geom" };
const bbox = (...b: number[]) => ({ op: "s_intersects", args: [geom, { bbox: b }] });
const point = (x: number, y: number) => ({ op: "s_intersects", args: [geom, { type: "Point", coordinates: [x, y] }] });

// Table 12, as CQL2-JSON. The data's geometry is read where GeoJSON keeps it, under the standard's property name.
const TABLE_12: [string, string, unknown, number][] = [
  ["ne_110m_admin_0_countries", "S_INTERSECTS(geom,BBOX(0,40,10,50))", bbox(0, 40, 10, 50), 8],
  ["ne_110m_admin_0_countries", "S_INTERSECTS(geom,BBOX(150,-90,-150,90))", bbox(150, -90, -150, 90), 10],
  ["ne_110m_admin_0_countries", "S_INTERSECTS(geom,POINT(7.02 49.92))", point(7.02, 49.92), 1],
  ["ne_110m_admin_0_countries", "… BBOX(0,40,10,50) and … BBOX(5,50,10,60)", { op: "and", args: [bbox(0, 40, 10, 50), bbox(5, 50, 10, 60)] }, 3],
  ["ne_110m_admin_0_countries", "… BBOX(0,40,10,50) and not … BBOX(5,50,10,60)", { op: "and", args: [bbox(0, 40, 10, 50), { op: "not", args: [bbox(5, 50, 10, 60)] }] }, 5],
  ["ne_110m_admin_0_countries", "… BBOX(0,40,10,50) or … BBOX(-90,40,-60,50)", { op: "or", args: [bbox(0, 40, 10, 50), bbox(-90, 40, -60, 50)] }, 10],
  ["ne_110m_populated_places_simple", "S_INTERSECTS(geom,BBOX(0,40,10,50))", bbox(0, 40, 10, 50), 7],
  ["ne_110m_rivers_lake_centerlines", "S_INTERSECTS(geom,BBOX(-180,-90,0,90))", bbox(-180, -90, 0, 90), 4],
];

describe("the standard's Table 12, on Natural Earth", () => {
  it.each(TABLE_12)("%s: %s → %i", (dataset, _text, filter, expected) => {
    const selects = toPredicate(filter as Cql2Filter, { geometryProperty: "geom" });
    expect(DATA[dataset]!.filter(selects).length).toBe(expected);
  });
});

// Table 14, as CQL2-JSON, each with the standard's CQL2-text.
const op = (name: string, literal: unknown) => ({ op: name, args: [geom, literal] });
const P = (x: number, y: number) => ({ type: "Point", coordinates: [x, y] });
const L = (...c: number[][]) => ({ type: "LineString", coordinates: c });
const A = (...c: number[][]) => ({ type: "Polygon", coordinates: [c] });
const B = (...b: number[]) => ({ bbox: b });
const SQUARE = A([0, 40], [10, 40], [10, 50], [0, 50], [0, 40]);
const LUX = [[6.043073357781111, 50.128051662794235], [6.242751092156993, 49.90222565367873], [6.186320428094177, 49.463802802114515],
  [5.897759230176348, 49.44266714130711], [5.674051954784829, 49.529483547557504], [5.782417433300907, 50.09032786722122], [6.043073357781111, 50.128051662794235]];
const [C, PL, R] = ["ne_110m_admin_0_countries", "ne_110m_populated_places_simple", "ne_110m_rivers_lake_centerlines"];
const TABLE_14: [string, string, unknown, number][] = [
  [C, "S_INTERSECTS(geom,POLYGON((0 40,10 40,10 50,0 50,0 40)))", op("s_intersects", SQUARE), 8],
  [C, "S_INTERSECTS(geom,LINESTRING(0 40,10 50))", op("s_intersects", L([0, 40], [10, 50])), 4],
  [PL, "S_INTERSECTS(geom,POLYGON((0 40,10 40,10 50,0 50,0 40)))", op("s_intersects", SQUARE), 7],
  [R, "S_INTERSECTS(geom,LINESTRING(-60 -90,-60 90))", op("s_intersects", L([-60, -90], [-60, 90])), 2],
  [C, "S_DISJOINT(geom,BBOX(0,40,10,50))", op("s_disjoint", B(0, 40, 10, 50)), 169],
  [C, "S_DISJOINT(geom,POLYGON((0 40,10 40,10 50,0 50,0 40)))", op("s_disjoint", SQUARE), 169],
  [C, "S_DISJOINT(geom,LINESTRING(0 40,10 50))", op("s_disjoint", L([0, 40], [10, 50])), 173],
  [C, "S_DISJOINT(geom,POINT(7.02 49.92))", op("s_disjoint", P(7.02, 49.92)), 176],
  [PL, "S_DISJOINT(geom,BBOX(0,40,10,50))", op("s_disjoint", B(0, 40, 10, 50)), 236],
  [PL, "S_DISJOINT(geom,POLYGON((0 40,10 40,10 50,0 50,0 40)))", op("s_disjoint", SQUARE), 236],
  [R, "S_DISJOINT(geom,BBOX(-180,-90,0,90))", op("s_disjoint", B(-180, -90, 0, 90)), 9],
  [R, "S_DISJOINT(geom,LINESTRING(-60 -90,-60 90))", op("s_disjoint", L([-60, -90], [-60, 90])), 11],
  [PL, "S_EQUALS(geom,POINT(6.1300028 49.6116604))", op("s_equals", P(6.1300028, 49.6116604)), 1],
  [C, `S_TOUCHES(geom,POLYGON((${LUX.map((p) => p.join(" ")).join(",")})))`, op("s_touches", A(...LUX)), 3],
  [C, "S_TOUCHES(geom,POINT(6.043073357781111 50.128051662794235))", op("s_touches", P(LUX[0]![0]!, LUX[0]![1]!)), 3],
  [C, "S_TOUCHES(geom,POINT(6.242751092156993 49.90222565367873))", op("s_touches", P(LUX[1]![0]!, LUX[1]![1]!)), 2],
  [C, "S_TOUCHES(geom,LINESTRING(6.043073357781111 50.128051662794235,6.242751092156993 49.90222565367873))", op("s_touches", L(LUX[0]!, LUX[1]!)), 3],
  [R, "S_CROSSES(geom,BBOX(0,40,10,50))", op("s_crosses", B(0, 40, 10, 50)), 1],
  [R, "S_CROSSES(geom,LINESTRING(-60 -90,-60 90))", op("s_crosses", L([-60, -90], [-60, 90])), 2],
  [C, "S_WITHIN(geom,BBOX(-180,-90,0,90))", op("s_within", B(-180, -90, 0, 90)), 44],
  [PL, "S_WITHIN(geom,BBOX(-180,-90,0,90))", op("s_within", B(-180, -90, 0, 90)), 74],
  [R, "S_WITHIN(geom,BBOX(-180,-90,0,90))", op("s_within", B(-180, -90, 0, 90)), 4],
  [C, "S_CONTAINS(geom,BBOX(7,50,8,51))", op("s_contains", B(7, 50, 8, 51)), 1],
  [C, "S_CONTAINS(geom,LINESTRING(7 50,8 51))", op("s_contains", L([7, 50], [8, 51])), 1],
  [C, "S_CONTAINS(geom,POINT(7.02 49.92))", op("s_contains", P(7.02, 49.92)), 1],
  [C, "S_OVERLAPS(geom,BBOX(-180,-90,0,90))", op("s_overlaps", B(-180, -90, 0, 90)), 11],
];

describe("the standard's Table 14, on Natural Earth, with GEOS plugged in", () => {
  it.each(TABLE_14)("%s: %s → %i", (dataset, text, filter, expected) => {
    expect(toText(filter as Cql2Filter).replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
    const selects = toPredicate(filter as Cql2Filter, { geometryProperty: "geom", spatialEngine: geosEngine });
    expect(DATA[dataset]!.filter(selects).length).toBe(expected);
  });
});
