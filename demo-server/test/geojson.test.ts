/** The GeoJSON store: the id rules, the queryables, the CRS rule, and querying. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGeoJsonStore, inferQueryables, prepareFeatures } from "../src/stores/geojson.ts";

const fc = (features: unknown[], extra: Record<string, unknown> = {}) => ({ type: "FeatureCollection", ...extra, features });
const f = (id: unknown, properties: Record<string, unknown> = {}) =>
  id === undefined ? { type: "Feature", geometry: null, properties } : { type: "Feature", id, geometry: null, properties };
const ids = (json: unknown) => prepareFeatures(json, "test").features.map((x) => x.id);

describe("ids", () => {
  it("keeps unique ids, strings and numbers", () => {
    assert.deepEqual(ids(fc([f("a"), f(7), f("b")])), ["a", 7, "b"]);
    assert.deepEqual(prepareFeatures(fc([f("a"), f(7)]), "test").warnings, []);
  });

  it("generates the position in the file when no feature has an id", () => {
    assert.deepEqual(ids(fc([f(undefined), f(undefined), f(undefined)])), [1, 2, 3]);
  });

  it("generates numbers after the largest numeric id when some features have ids", () => {
    assert.deepEqual(ids(fc([f(10), f(undefined), f("x"), f(3), f(undefined)])), [10, 11, "x", 3, 12]);
  });

  it("uses positions when the only ids are strings: they can't collide with numbers", () => {
    assert.deepEqual(ids(fc([f("1"), f(undefined)])), ["1", 2]);
  });

  it("drops a later feature with a duplicate id and reports it", () => {
    const { features, warnings } = prepareFeatures(fc([f(1, { n: "first" }), f(2), f(1, { n: "second" }), f(2)]), "test");
    assert.deepEqual(features.map((x) => [x.id, x.properties.n]), [[1, "first"], [2, undefined]]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Dropped 2 feature\(s\) with a duplicate id: feature 3 \(id 1, already used by feature 1\); feature 4 \(id 2, already used by feature 2\)/);
  });

  it("1 and \"1\" are different ids", () => {
    assert.deepEqual(ids(fc([f(1), f("1")])), [1, "1"]);
  });

  it("an id that is neither a string nor a number is replaced, and reported", () => {
    const { features, warnings } = prepareFeatures(fc([f({ x: 1 }), f(5)]), "test");
    assert.deepEqual(features.map((x) => x.id), [6, 5]);
    assert.match(warnings.join(" "), /neither a string nor a number/);
  });

  it("missing properties become {}", () => {
    assert.deepEqual(prepareFeatures(fc([{ type: "Feature", geometry: null }]), "test").features[0]!.properties, {});
  });
});

describe("the file", () => {
  it("must be a FeatureCollection", () => {
    assert.throws(() => prepareFeatures({ type: "Feature" }, "x.geojson"), /x\.geojson is not a GeoJSON FeatureCollection/);
  });

  it("may name CRS84 in a legacy crs member, and nothing else", () => {
    const crs = (name: string) => ({ crs: { type: "name", properties: { name } } });
    assert.doesNotThrow(() => prepareFeatures(fc([], crs("urn:ogc:def:crs:OGC:1.3:CRS84")), "x"));
    assert.throws(() => prepareFeatures(fc([], crs("urn:ogc:def:crs:EPSG::3857")), "x"), /only WGS 84 longitude, latitude/);
  });
});

describe("queryables", () => {
  const features = prepareFeatures(
    fc([
      f(1, { name: "a", n: 1, x: 1.5, ok: true, d: "2020-01-01", t: "2020-01-01T00:00:00Z", mixed: 1, empty: null }),
      f(2, { name: "b", n: 2, x: 2, ok: false, d: "2021-02-03", t: "2021-02-03T10:00:00+02:00", mixed: "1" }),
    ]),
    "test",
  ).features;

  it("types and formats from the values", () => {
    const { queryables, warnings } = inferQueryables(features);
    assert.deepEqual(queryables, {
      name: { type: "string" },
      n: { type: "integer" },
      x: { type: "number" },
      ok: { type: "boolean" },
      d: { type: "string", format: "date" },
      t: { type: "string", format: "date-time" },
      mixed: {},
      empty: {},
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"mixed" holds values of mixed types \(integer, string\)/);
  });
});

describe("query", () => {
  const store = createGeoJsonStore(
    { id: "t", title: "Test" },
    fc([f(1, { pop: 10 }), f(2, { pop: 30 }), f(3, { pop: null }), f(4, { pop: 50 }), f(5, { pop: 70 })]),
  );

  it("selects with three-valued logic and pages the result", () => {
    const filter = { op: ">", args: [{ property: "pop" }, 20] } as const;
    assert.deepEqual(store.query(filter, { limit: 10, offset: 0 }).features.map((x) => x.id), [2, 4, 5]);
    const page = store.query(filter, { limit: 2, offset: 1 });
    assert.deepEqual([page.numberMatched, page.features.map((x) => x.id)], [3, [4, 5]]);
    // NOT on a null value is NULL too: feature 3 is in neither result.
    assert.deepEqual(store.query({ op: "not", args: [filter] }, { limit: 10, offset: 0 }).features.map((x) => x.id), [1]);
  });

  it("describes itself", () => {
    assert.deepEqual(store.describe(), { id: "t", title: "Test", source: "geojson", featureCount: 5, warnings: [] });
  });
});
