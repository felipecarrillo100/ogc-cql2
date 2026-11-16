/**
 * Array Functions on GeoPackage (the sqlite dialect, since ogc-cql2 1.6.0): every generated array filter selects,
 * through the store, what `evaluate` selects on the rows the store serves, for arrays stored as TEXT JSON the way GDAL
 * writes list fields, with the values where engines disagree and where SQLite's own JSON reading parts from JSON.parse
 * (data/arrays.gpkg, written by data/make-arrays-gpkg.ts; the columns and their items listed as in collections.json).
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { toEvaluator } from "ogc-cql2/evaluate";
import { generateArrayFilters } from "../../test/corpus.ts";
import { openGeoPackage } from "../src/stores/geopackage.ts";
import type { Feature, Store } from "../src/stores/types.ts";

const ITEMS = {
  tags: { type: "string" }, codes: { type: "string" }, ratios: { type: "number" }, counts: { type: "integer" },
  flags: { type: "boolean" }, days: { type: "string", format: "date" }, moments: { type: "string", format: "date-time" }, doc: {},
};

let store: Store;
let warnings: string[];
let served: readonly Feature[] = [];

before(async () => {
  const opened = openGeoPackage({ file: new URL("../data/arrays.gpkg", import.meta.url).pathname, prefix: "gpkg-", arrays: { arrays: ITEMS } });
  store = opened.stores[0]!.store;
  warnings = opened.warnings;
  served = (await store.query(true, { limit: 1000, offset: 0 })).features;
});

const ids = (features: readonly Feature[]) => features.map((f) => f.id);

describe("GeoPackage arrays (JSON text)", () => {
  it("the queryables: each listed column an array with its items", () => {
    assert.deepEqual(warnings, []);
    assert.deepEqual(store.describe().warnings, []);
    assert.deepEqual(store.queryables(), {
      title: { type: "string" },
      ...Object.fromEntries(Object.entries(ITEMS).map(([name, items]) => [name, { type: "array", items }])),
    });
  });

  it("served as JSON.parse reads them, the text itself when it isn't JSON", () => {
    const row = (id: number) => served.find((f) => f.id === id)!.properties;
    assert.deepEqual(row(1).tags, ["a", "b"]);
    assert.deepEqual(row(3).tags, []);
    assert.equal(row(4).tags, null);
    assert.deepEqual(row(5).tags, ["a", null]);
    assert.equal(row(9).days, "not json");
    assert.deepEqual(row(9).codes, { not: "an array" });
    assert.deepEqual(row(13).counts, [9007199254740992, 9007199254740991]);
    assert.deepEqual(row(13).tags, ["a\u0000b", "\ud800"]);
    assert.ok(served.every((f) => (f.geometry as { type?: string } | null)?.type === "Point"));
  });

  it("every generated array filter selects what evaluate selects on the served rows", async () => {
    const queryables = store.queryables();
    const filters = generateArrayFilters(Object.keys(ITEMS));
    assert.ok(filters.length > 2000);
    const wrong: string[] = [];
    for (const filter of filters) {
      const expected = ids(served.filter((f) => toEvaluator(filter, { queryables })(f) === true));
      const got = ids((await store.query(filter, { limit: 1000, offset: 0 })).features);
      if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${JSON.stringify(filter)}: ${JSON.stringify(got)}, evaluate ${JSON.stringify(expected)}`);
    }
    assert.deepEqual(wrong.slice(0, 5), []);
  });
});
