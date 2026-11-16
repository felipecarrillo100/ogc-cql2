/**
 * Array Functions in SQL Server (since ogc-cql2 1.6.0): every generated array filter selects, through the store, what
 * `evaluate` selects on the rows the store serves, for arrays held as JSON text (nvarchar, UTF-8 varchar) and, on SQL
 * Server 2025, in the `json` type, with the values where engines disagree (data/arrays-rows.ts); and the same under
 * session settings that would change the answers. Runs against the database that `MSSQL_*` names (in `.env`), with
 * `dbo.arrays` loaded (data/load-sqlserver.ts); skipped otherwise.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type mssql from "mssql";
import { toEvaluator } from "ogc-cql2/evaluate";
import { toSql, type SqlColumn } from "ogc-cql2/sql";
import { generateArrayFilters } from "../../test/corpus.ts";
import { COLUMNS } from "../data/arrays-rows.ts";
import { createSqlServerPool, openSqlServer } from "../src/stores/sqlserver.ts";
import type { Feature, ScalarQueryable, Store } from "../src/stores/types.ts";

/** What each column's elements hold, as collections.json lists them. */
const ITEMS: Record<(typeof COLUMNS)[number], ScalarQueryable> = {
  tags: { type: "string" }, codes: { type: "string" }, ratios: { type: "number" }, counts: { type: "integer" },
  flags: { type: "boolean" }, days: { type: "string", format: "date" }, moments: { type: "string", format: "date-time" }, doc: {},
};
const TEXT: Record<string, ScalarQueryable> = { ...ITEMS, doc_utf8: {} };
const JSON_TYPE: Record<string, ScalarQueryable> = Object.fromEntries(COLUMNS.map((c) => [`${c}_json`, ITEMS[c]]));

let pool: mssql.ConnectionPool | undefined;
let skip = "";
let store: Store | undefined;
let json = false;
let arrays: Record<string, ScalarQueryable> = {};
let served: readonly Feature[] = [];

before(async () => {
  if (!process.env.MSSQL_DATABASE) {
    skip = "no MSSQL_DATABASE: add SQL Server's connection to demo-server's .env (see data/load-sqlserver.ts)";
    return;
  }
  try {
    pool = await createSqlServerPool();
    const [row] = (await pool.request().query<{ major: number }>("SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major")).recordset;
    json = row!.major >= 17;
    arrays = { ...TEXT, ...(json ? JSON_TYPE : {}) };
    const result = await openSqlServer(pool, { prefix: "t-", tables: [{ table: "dbo.arrays", arrays }] });
    store = result.stores[0]?.store;
    if (!store) skip = `dbo.arrays isn't loaded in SQL Server (${result.warnings.join(" ")}): run data/load-sqlserver.ts`;
  } catch (error) {
    skip = `SQL Server isn't reachable: ${(error as Error).message}`;
  }
  if (store) served = (await store.query(true, { limit: 1000, offset: 0 })).features;
}, { timeout: 60_000 });
after(async () => {
  await pool?.close();
});

const ids = (features: readonly Feature[]) => features.map((f) => f.id);

describe("SQL Server arrays", () => {
  it("the queryables: the listed JSON columns as arrays of their items", (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(store!.queryables(), {
      title: { type: "string" },
      ...Object.fromEntries(Object.entries(arrays).map(([c, items]) => [c, { type: "array", items }])),
    });
    assert.deepEqual(store!.describe().warnings, []);
  });

  it("served: text as JSON.parse reads it (or the text, when it isn't JSON); the json type as SQL Server stored it", (t) => {
    if (skip) return t.skip(skip);
    const row = (id: number) => served.find((f) => f.id === id)!.properties;
    assert.deepEqual(row(1).tags, ["a", "b"]);
    assert.equal(row(4).tags, null);
    assert.deepEqual(row(5).tags, ["a", null]);
    assert.equal(row(9).days, "not json");
    assert.equal(row(9).moments, "[1,]");
    assert.equal(row(9).doc, "");
    assert.deepEqual(row(13).counts, [9007199254740992, 9007199254740991]);
    assert.deepEqual(row(13).tags, ["a\u0000b", "\ud800"]);
    if (!json) return;
    assert.deepEqual(row(3).tags_json, []);
    assert.equal(row(9).days_json, null); // the json type refuses it
    assert.equal(row(9).tags_json, null); // a scalar
    assert.equal(row(13).ratios_json, null); // 1e400: out of the json type's range
    assert.deepEqual(row(13).tags_json, ["a\u0000b", "�"]); // a lone surrogate, stored as U+FFFD
  });

  /** The ids each filter selects, through the store, or in a batch of its own after `settings`. */
  const check = async (settings: string) => {
    const queryables = store!.queryables();
    const filters = generateArrayFilters(Object.keys(arrays));
    assert.ok(filters.length > 2000);
    const columns: Record<string, SqlColumn> = Object.fromEntries(Object.entries(arrays).map(([c, items]) => [c, { sqlType: c.endsWith("_json") ? "json" : c === "doc_utf8" ? "varchar" : "nvarchar", items }]));
    const wrong: string[] = [];
    for (const filter of filters) {
      const expected = ids(served.filter((f) => toEvaluator(filter, { queryables })(f) === true));
      let got: (string | number)[];
      if (settings) {
        const { where, params } = toSql(filter, { dialect: "sqlserver", columns });
        const request = pool!.request();
        params.forEach((value, i) => request.input(`p${i + 1}`, value));
        got = (await request.query<{ id: number }>(`${settings}; SELECT id FROM dbo.arrays WHERE ${where} ORDER BY id`)).recordset.map((r) => r.id);
      } else {
        got = ids((await store!.query(filter, { limit: 1000, offset: 0 })).features);
      }
      if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${JSON.stringify(filter)}: ${JSON.stringify(got)}, evaluate ${JSON.stringify(expected)}`);
    }
    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} of ${filters.length} differ`);
  };

  it("every generated array filter selects what evaluate selects on the served rows", { timeout: 1_200_000 }, async (t) => {
    if (skip) return t.skip(skip);
    await check("");
  });

  it("the same under another language and date format", { timeout: 1_200_000 }, async (t) => {
    if (skip) return t.skip(skip);
    await check("SET LANGUAGE Deutsch; SET DATEFORMAT dmy");
  });
});
