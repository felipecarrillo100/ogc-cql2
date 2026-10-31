/**
 * The standard's own acceptance test for Basic Spatial Functions (OGC 21-065r2, Annex A.7, conformance test 26,
 * Table 12): eight predicates on Natural Earth 1:110m, and the number of features each must select.
 * The data is in test/fixtures/naturalearth/ (public domain).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";

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
