/**
 * Array Functions in PostgreSQL (since ogc-cql2 1.6.0): every generated array filter selects, through the store, what
 * `evaluate` selects on the rows the store serves, for native arrays (`text[]`, `character varying[]`,
 * `double precision[]`, `integer[]`, `boolean[]`, `date[]`, `timestamp with time zone[]`) and JSON arrays (`jsonb`,
 * `json`), with the values where engines disagree (data/arrays.sql). The GIN indexes on the `cql2_*_array` functions
 * serve the functions (the same SQL is exact under NOT, without an index). Runs against the database in `.env` with `cql2demo` loaded (load-postgres.sh);
 * skipped otherwise.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { toEvaluator } from "ogc-cql2/evaluate";
import { toSql, type SqlColumn } from "ogc-cql2/sql";
import type { Cql2Filter } from "ogc-cql2";
import { generateArrayFilters } from "../../test/corpus.ts";
import { createPool, openPostgres } from "../src/stores/postgres.ts";
import type { Feature, Store } from "../src/stores/types.ts";

let pool: ReturnType<typeof createPool> | undefined;
let skip = "";
let store: Store | undefined;
let served: readonly Feature[] = [];

before(async () => {
  if (!process.env.PGDATABASE) {
    skip = "no PGDATABASE: run the tests with demo-server's .env (npm test does)";
    return;
  }
  pool = createPool();
  try {
    const result = await openPostgres(pool, {
      prefix: "t-",
      functionSchema: "cql2demo",
      tables: [{ table: "cql2demo.arrays", arrays: { doc: {}, raw: {} } }],
    });
    store = result.stores[0]?.store;
    if (!store) skip = `cql2demo.arrays isn't loaded: run load-postgres.sh (${result.warnings.join(" ")})`;
  } catch (error) {
    skip = `PostgreSQL isn't reachable: ${(error as Error).message}`;
  }
  if (store) served = (await store.query(true, { limit: 1000, offset: 0 })).features;
});
after(async () => {
  await pool?.end();
});

const ids = (features: readonly Feature[]) => features.map((f) => f.id);

describe("PostgreSQL arrays", () => {
  it("the queryables: native arrays by their element type, JSON arrays as the config declares them", (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(store!.queryables(), {
      title: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      codes: { type: "array", items: { type: "string" } },
      ratios: { type: "array", items: { type: "number" } },
      counts: { type: "array", items: { type: "integer" } },
      flags: { type: "array", items: { type: "boolean" } },
      days: { type: "array", items: { type: "string", format: "date" } },
      moments: { type: "array", items: { type: "string", format: "date-time" } },
      doc: { type: "array", items: {} },
      raw: { type: "array", items: {} },
    });
  });

  it("served as JSON arrays, each element as the scalar rules serve it; a matrix as its text, no CQL2 array", (t) => {
    if (skip) return t.skip(skip);
    const row = (id: number) => served.find((f) => f.id === id)!.properties;
    assert.deepEqual(row(1).moments, ["2010-02-10T05:30:00.123Z"]);
    assert.deepEqual(row(3).tags, []);
    assert.equal(row(4).tags, null);
    assert.deepEqual(row(5).tags, ["a", null]);
    assert.deepEqual(row(7).days, ["infinity", "2010-02-10"]);
    assert.equal(row(9).tags, "{{a,b},{c,d}}");
    assert.deepEqual(row(10).doc, [["a"], { k: 1 }, Infinity, 0, "a"]);
  });

  it("every generated array filter selects what evaluate selects on the served rows", async (t) => {
    if (skip) return t.skip(skip);
    const queryables = store!.queryables();
    const filters = generateArrayFilters(Object.keys(queryables).filter((n) => n !== "title"));
    assert.ok(filters.length > 3000);
    const wrong: string[] = [];
    for (const filter of filters) {
      const expected = ids(served.filter((f) => toEvaluator(filter, { queryables })(f) === true));
      const got = ids((await store!.query(filter, { limit: 1000, offset: 0 })).features);
      if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${JSON.stringify(filter)}: ${JSON.stringify(got)}, evaluate ${JSON.stringify(expected)}`);
    }
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  it("the GIN indexes on cql2_text_array, cql2_number_array and cql2_instant_array serve the functions", async (t) => {
    if (skip) return t.skip(skip);
    const columns: Record<string, SqlColumn> = {
      tags: { sqlType: "text[]" },
      ratios: { sqlType: "double precision[]" },
      moments: { sqlType: "timestamp with time zone[]" },
    };
    const plan = async (filter: Cql2Filter): Promise<string> => {
      const { where, params } = toSql(filter, { dialect: "postgres", columns, functionSchema: "cql2demo" });
      const client = await pool!.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off"); // a table of a dozen rows: else the planner scans it
        const { rows } = await client.query(`EXPLAIN SELECT id FROM cql2demo.arrays WHERE ${where}`, [...params]);
        return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const fn = (op: string, property: string, set: unknown[]) => ({ op, args: [{ property }, set] }) as Cql2Filter;
    for (const [filter, index] of [
      [fn("a_contains", "tags", ["a"]), "arrays_tags"],
      [fn("a_overlaps", "tags", ["a", "x"]), "arrays_tags"],
      [fn("a_equals", "ratios", [1, 2.5]), "arrays_ratios"],
      [fn("a_contains", "moments", [{ timestamp: "2010-02-10T05:30:00.123Z" }]), "arrays_moments"],
    ] as const) {
      assert.match(await plan(filter as Cql2Filter), new RegExp(`Index Scan on ${index}`), JSON.stringify(filter));
    }
  });
});
