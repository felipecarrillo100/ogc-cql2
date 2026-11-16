/**
 * Array Functions in Oracle (since ogc-cql2 1.6.0): every generated array filter selects, through the store, what
 * `evaluate` selects on the rows the store serves, for arrays held as JSON text (VARCHAR2, CLOB) and in the `JSON`
 * type, with the values where engines disagree (data/arrays-rows.ts); and the same under a session whose NLS settings
 * would change the answers. Runs against the database that `ORACLE_CONNECT`, `ORACLE_USER` and `ORACLE_PASSWORD` name
 * (in `.env`), with `ARRAYS` loaded (data/load-oracle.ts); skipped otherwise.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import oracledb from "oracledb";
import { toEvaluator } from "ogc-cql2/evaluate";
import { toSql, type SqlColumn } from "ogc-cql2/sql";
import { generateArrayFilters } from "../../test/corpus.ts";
import { COLUMNS } from "../data/arrays-rows.ts";
import { createOraclePool, openOracle } from "../src/stores/oracle.ts";
import type { Feature, ScalarQueryable, Store } from "../src/stores/types.ts";

/** What each column's elements hold, as collections.json lists them. */
const ITEMS: Record<(typeof COLUMNS)[number], ScalarQueryable> = {
  tags: { type: "string" }, codes: { type: "string" }, ratios: { type: "number" }, counts: { type: "integer" },
  flags: { type: "boolean" }, days: { type: "string", format: "date" }, moments: { type: "string", format: "date-time" }, doc: {},
};
const ARRAYS: Record<string, ScalarQueryable> = {
  ...ITEMS,
  ...Object.fromEntries(COLUMNS.map((c) => [`${c}_json`, ITEMS[c]])),
  doc_clob: {},
};

let pool: Awaited<ReturnType<typeof createOraclePool>> | undefined;
let skip = "";
let store: Store | undefined;
let warnings: string[] = [];
let served: readonly Feature[] = [];

before(async () => {
  if (!process.env.ORACLE_CONNECT) {
    skip = "no ORACLE_CONNECT: add Oracle's connection to demo-server's .env (see data/load-oracle.ts)";
    return;
  }
  try {
    pool = await createOraclePool();
    const result = await openOracle(pool, { prefix: "t-", tables: [{ table: "ARRAYS", arrays: ARRAYS }] });
    store = result.stores[0]?.store;
    warnings = result.warnings;
    if (!store) skip = `ARRAYS isn't loaded in Oracle (${warnings.join(" ")}): run data/load-oracle.ts`;
  } catch (error) {
    skip = `Oracle isn't reachable: ${(error as Error).message}`;
  }
  if (store) served = (await store.query(true, { limit: 1000, offset: 0 })).features;
}, { timeout: 60_000 });
after(async () => {
  await pool?.close(0);
});

const ids = (features: readonly Feature[]) => features.map((f) => f.id);

describe("Oracle arrays", () => {
  it("the queryables: the listed JSON columns as arrays of their items", (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(store!.queryables(), {
      title: { type: "string" },
      ...Object.fromEntries(Object.entries(ARRAYS).map(([c, items]) => [c, { type: "array", items }])),
    });
    assert.deepEqual(store!.describe().warnings, []);
  });

  it("served: text as JSON.parse reads it (or the text, when it isn't JSON); the JSON type as Oracle stored it", (t) => {
    if (skip) return t.skip(skip);
    const row = (id: number) => served.find((f) => f.id === id)!.properties;
    assert.deepEqual(row(1).tags, ["a", "b"]);
    assert.deepEqual(row(3).tags_json, []);
    assert.equal(row(4).tags, null);
    assert.deepEqual(row(5).tags, ["a", null]);
    assert.equal(row(9).days, "not json");
    assert.equal(row(9).days_json, null); // Oracle refuses it in the JSON type
    assert.deepEqual(row(9).moments, "[1,]"); // not JSON to JSON.parse…
    assert.deepEqual(row(9).moments_json, [1]); // …lax JSON to Oracle, stored repaired
    assert.equal(row(9).doc, null); // '' is NULL in Oracle
    assert.deepEqual(row(13).counts, [9007199254740992, 9007199254740991]);
    assert.deepEqual(row(7).ratios, [1e300, -1e300]); // read through JSON(): doubles, not NUMBER's range
    // A lone surrogate, no Unicode text: JSON.parse keeps it; Oracle stores bytes no Unicode text has (ED A0 80),
    // which the driver reads back as three replacement characters.
    assert.deepEqual(row(13).tags, ["a\u0000b", "\ud800"]);
    assert.deepEqual(row(13).tags_json, ["a\u0000b", "\ufffd\ufffd\ufffd"]);
  });

  /** The ids `filter` selects, through the store, and through a session of its own with `settings`. */
  const check = async (settings: string) => {
    const queryables = store!.queryables();
    const filters = generateArrayFilters(Object.keys(ARRAYS));
    assert.ok(filters.length > 5000);
    const columns: Record<string, SqlColumn> = Object.fromEntries(Object.entries(ARRAYS).map(([c, items]) => [c, { sqlType: c.endsWith("_json") ? "JSON" : c === "doc_clob" ? "CLOB" : "VARCHAR2", items }]));
    const c = settings ? await oracledb.getConnection({ connectString: process.env.ORACLE_CONNECT, user: process.env.ORACLE_USER, password: process.env.ORACLE_PASSWORD }) : undefined;
    try {
      if (c) await c.execute(`ALTER SESSION SET ${settings}`);
      const wrong: string[] = [];
      let surrogates = 0;
      for (const filter of filters) {
        const expected = ids(served.filter((f) => toEvaluator(filter, { queryables })(f) === true));
        let got: (string | number)[];
        if (c) {
          const { where, params } = toSql(filter, { dialect: "oracle", columns });
          got = (await c.execute<[number]>(`SELECT "id" FROM arrays WHERE ${where} ORDER BY "id"`, [...params])).rows!.map((r) => r[0]);
        } else {
          got = ids((await store!.query(filter, { limit: 1000, offset: 0 })).features);
        }
        if (JSON.stringify(got) === JSON.stringify(expected)) continue;
        // The one known difference: row 13's lone surrogate, held as text in one column and in the JSON type in the
        // other (the same bytes to Oracle, not as served: see above).
        const text = /"property":"(tags|doc|doc_clob)"/.test(JSON.stringify(filter));
        const json = /"property":"(tags|doc)_json"/.test(JSON.stringify(filter));
        const only13 = [...got.filter((id) => !expected.includes(id)), ...expected.filter((id) => !got.includes(id))];
        if (text && json && JSON.stringify(only13) === "[13]") surrogates++;
        else wrong.push(`${JSON.stringify(filter)}: ${JSON.stringify(got)}, evaluate ${JSON.stringify(expected)}`);
      }
      assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} of ${filters.length} differ`);
      assert.ok(surrogates > 0); // the data still holds the case
    } finally {
      await c?.close();
    }
  };

  it("every generated array filter selects what evaluate selects on the served rows", { timeout: 600_000 }, async (t) => {
    if (skip) return t.skip(skip);
    await check("");
  });

  it("the same under another decimal separator and a linguistic, case-insensitive sort", { timeout: 600_000 }, async (t) => {
    if (skip) return t.skip(skip);
    await check("NLS_NUMERIC_CHARACTERS = ',.' NLS_COMP = LINGUISTIC NLS_SORT = GERMAN_CI");
  });
});
