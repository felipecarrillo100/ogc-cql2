/**
 * Array Functions on GeoParquet (DuckDB, since ogc-cql2 1.6.0): every generated array filter selects, through the
 * store, what `evaluate` selects on the rows the store serves, for DuckDB's lists (`VARCHAR[]`, `DOUBLE[]`,
 * `INTEGER[]`, `BOOLEAN[]`, `DATE[]`, `TIMESTAMP WITH TIME ZONE[]`, a list of lists), with the values where engines
 * disagree (data/arrays.parquet, written by data/make-arrays-parquet.ts).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { toEvaluator } from "ogc-cql2/evaluate";
import { generateArrayFilters } from "../../test/corpus.ts";
import { openDuckDB, openGeoParquet, type DuckDB } from "../src/stores/duckdb.ts";
import type { Feature, Store } from "../src/stores/types.ts";

let duck: DuckDB;
let store: Store;
let served: readonly Feature[] = [];

before(async () => {
  duck = await openDuckDB();
  store = await openGeoParquet(duck, { id: "arrays", title: "Arrays", file: new URL("../data/arrays.parquet", import.meta.url).pathname });
  served = (await store.query(true, { limit: 1000, offset: 0 })).features;
});
after(() => duck.close());

const ids = (features: readonly Feature[]) => features.map((f) => f.id);

describe("GeoParquet arrays (DuckDB lists)", () => {
  it("the queryables: each list by its element type, a list of lists as values of no kind", () => {
    assert.deepEqual(store.queryables(), {
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      codes: { type: "array", items: { type: "string" } },
      ratios: { type: "array", items: { type: "number" } },
      counts: { type: "array", items: { type: "integer" } },
      flags: { type: "array", items: { type: "boolean" } },
      days: { type: "array", items: { type: "string", format: "date" } },
      moments: { type: "array", items: { type: "string", format: "date-time" } },
      nested: { type: "array", items: {} },
    });
  });

  it("served as arrays, each element as the scalar rules serve it", () => {
    const row = (id: number) => served.find((f) => f.id === id)!.properties;
    assert.deepEqual(row(1).moments, ["2010-02-10T05:30:00.123Z"]);
    assert.deepEqual(row(3).tags, []);
    assert.equal(row(4).tags, null);
    assert.deepEqual(row(5).tags, ["a", null]);
    assert.deepEqual(row(7).days, ["infinity", "2010-02-10"]);
    assert.deepEqual(row(9).nested, [["a", "b"], ["c", "d"]]);
  });

  it("every generated array filter selects what evaluate selects on the served rows", async () => {
    const queryables = store.queryables();
    const filters = generateArrayFilters(Object.keys(queryables).filter((n) => n !== "title"));
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
