/**
 * The Oracle store: queryables from the declared types, ids, what it refuses to serve, and the routes on its
 * collections. Runs against the database that `ORACLE_CONNECT`, `ORACLE_USER` and `ORACLE_PASSWORD` name (in `.env`),
 * with the kitchen sink loaded (data/load-oracle.ts); skipped otherwise. The server's collections.json doesn't list
 * Oracle tables yet: the routes are tested on an app made of these stores.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import oracledb from "oracledb";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { geosEngine } from "../src/geos-engine.ts";
import { oracleValue, toSql, type SqlColumn } from "ogc-cql2/sql";
import { fileURLToPath } from "node:url";
import { closeStores, createApp, loadStores } from "../src/server.ts";
import { createOraclePool, openOracle } from "../src/stores/oracle.ts";
import type { Store } from "../src/stores/types.ts";

let pool: Awaited<ReturnType<typeof createOraclePool>> | undefined;
let skip = "";
const opened: Record<string, Store> = {};
let warnings: string[] = [];
let server: Server | undefined;
let base = "";

before(async () => {
  if (!process.env.ORACLE_CONNECT) {
    skip = "no ORACLE_CONNECT: add Oracle's connection to demo-server's .env (see data/load-oracle.ts)";
    return;
  }
  try {
    pool = await createOraclePool();
    const result = await openOracle(pool, {
      prefix: "ora-",
      tables: [
        { table: "KITCHEN_SINK", days: ["day"] },
        { table: "NO_SUCH_TABLE" },
        { table: "CQL2_CASEFOLD", title: "Case folding" }, // its primary key is text: served, with string ids
      ],
    });
    for (const { id, store } of result.stores) opened[id] = store;
    warnings = result.warnings;
    if (!opened["ora-kitchen_sink"]) skip = `the kitchen sink isn't loaded in Oracle (${warnings.join(" ")}): run data/load-oracle.ts`;
  } catch (error) {
    skip = `Oracle isn't reachable: ${(error as Error).message}`;
  }
  if (skip) return;
  server = createApp(new Map([["ora-kitchen_sink", opened["ora-kitchen_sink"]!]]), () => {}).listen(0);
  await new Promise((done) => server!.once("listening", done));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
}, { timeout: 60_000 });
after(async () => {
  server?.close();
  await pool?.close(0);
});

const read = async (res: Response | Promise<Response>): Promise<any> => (await res).json();
const query = async (collection: string, body: unknown): Promise<Response> =>
  (await fetch(`${base}/collections/${collection}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("the Oracle store", () => {
  it("queryables from the declared Oracle types; a DATE is a day only when listed in days", async (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(opened["ora-kitchen_sink"]!.queryables(), {
      name: { type: "string" }, // VARCHAR2
      code: { type: "string" },
      small: { type: "integer" }, // NUMBER(5)
      count: { type: "integer" },
      big: { type: "integer" }, // NUMBER(19), served as a number
      ratio: { type: "number" }, // BINARY_DOUBLE
      amount: { type: "number" }, // NUMBER(12,2)
      active: { type: "boolean" }, // BOOLEAN (23ai)
      day: { type: "string", format: "date" }, // DATE, listed in days
      at: { type: "string", format: "date-time" }, // TIMESTAMP WITH TIME ZONE
      local_at: { type: "string" }, // TIMESTAMP: no zone, not an instant
      until: { type: "string", format: "date-time" },
      note: { type: "string" },
    });
    const notDays = (await openOracle(pool!, { prefix: "dt-", tables: [{ table: "KITCHEN_SINK" }] })).stores[0]!.store;
    assert.deepEqual(notDays.queryables().day, { type: "string" }); // a DATE not listed in days: a date-time, no zone
  });

  it("features: the primary key as id, values as the dialect compares them (a DATE not a day as a date-time)", async (t) => {
    if (skip) return t.skip(skip);
    const filter = { op: "=" as const, args: [{ property: "name" }, "Straße"] as [{ property: string }, string] };
    const { features } = await opened["ora-kitchen_sink"]!.query(filter, { limit: 10, offset: 0 });
    assert.deepEqual(features, [{
      type: "Feature",
      id: 1,
      geometry: { type: "Point", coordinates: [4.35, 50.85] }, // the SDO_GEOMETRY's ordinates, exactly
      properties: {
        name: "Straße", code: "100%", small: 1, count: 5, big: 9007199254740991, ratio: 2.5, amount: 12.34, active: true,
        day: "2020-07-26", at: "2023-01-01T00:00:00.000Z", local_at: "2023-01-01T10:00:00.000", until: "2023-12-31T23:59:59.999Z",
        note: "2020-07-26",
      },
    }]);
    const notDays = (await openOracle(pool!, { prefix: "dt-", tables: [{ table: "KITCHEN_SINK" }] })).stores[0]!.store;
    assert.equal((await notDays.query(filter, { limit: 10, offset: 0 })).features[0]!.properties.day, "2020-07-26T00:00:00");
  });

  it("titles from the config, else the table name in lower case; a text primary key gives string ids", async (t) => {
    if (skip) return t.skip(skip);
    assert.equal(opened["ora-kitchen_sink"]!.describe().title, "kitchen_sink");
    assert.equal(opened["ora-cql2_casefold"]!.describe().title, "Case folding");
    const { features } = await opened["ora-cql2_casefold"]!.query({ op: "=", args: [{ property: "TO_TEXT" }, "ss"] }, { limit: 10, offset: 0 });
    assert.deepEqual(features.map((f) => f.id), ["ß", "ẞ"]);
  });

  it("reports a table it can't find, and missing cql2_* functions", async (t) => {
    if (skip) return t.skip(skip);
    assert.ok(warnings.some((w) => /Table "NO_SUCH_TABLE" not served: there is no such table/.test(w)), warnings.join("\n"));
    const elsewhere = await openOracle(pool!, { functionSchema: "SYSTEM", tables: [] });
    assert.match(elsewhere.warnings.join(" "), /The cql2_\* functions aren't in schema "SYSTEM"/);
  });

  it("declares every class; finds the spatial index", async (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(opened["ora-kitchen_sink"]!.conformance(), Object.values(CONFORMANCE));
    assert.equal(opened["ora-kitchen_sink"]!.hasGeometry(), true);
    // The index is used: the plan of a spatial filter shows it (SDO_FILTER through the DOMAIN INDEX).
    const filter = { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [0, 0, 6, 6] }] } as Cql2Filter;
    const { where, params } = toSql(filter, { dialect: "oracle", columns: { geometry: { format: "geometry-any", sqlType: "SDO_GEOMETRY", column: "GEOM", spatialIndex: true } } });
    const c = await pool!.getConnection();
    try {
      await c.execute(`EXPLAIN PLAN FOR SELECT "id" FROM kitchen_sink WHERE ${where}`, [...params]);
      const plan = (await c.execute<[string]>("SELECT operation || ' ' || options FROM plan_table WHERE plan_id = (SELECT MAX(plan_id) FROM plan_table)")).rows!.map((r) => r[0]);
      assert.ok(plan.some((step) => step.startsWith("DOMAIN INDEX")), plan.join(" / "));
    } finally {
      await c.close();
    }
  });
});

describe("collections.json serves the Oracle collections", () => {
  it("lists them, with their classes", async (t) => {
    if (skip) return t.skip(skip);
    const lines: string[] = [];
    const stores = await loadStores(fileURLToPath(new URL("../collections.json", import.meta.url)), (line) => lines.push(line));
    try {
      const app = createApp(stores, () => {}).listen(0);
      await new Promise((done) => app.once("listening", done));
      try {
        const answer = await read(fetch(`http://localhost:${(app.address() as AddressInfo).port}/collections`));
        const ours = answer.collections.filter((c: { id: string }) => c.id.startsWith("ora-"));
        assert.deepEqual(ours.map((c: { id: string; featureCount: number }) => [c.id, c.featureCount]), [["ora-states", 51], ["ora-kitchen_sink", 24]], lines.join("\n"));
        for (const c of ours) assert.deepEqual(c.conformance, Object.values(CONFORMANCE));
      } finally {
        app.close();
      }
    } finally {
      await closeStores();
    }
  });
});

describe("the routes on an Oracle collection", () => {
  it("answer a CQL2-text filter as its CQL2-JSON", async (t) => {
    if (skip) return t.skip(skip);
    const text = "CASEI(name) LIKE CASEI('stra%') AND T_AFTER(at, TIMESTAMP('2022-12-31T00:00:00Z'))";
    const json = {
      op: "and",
      args: [
        { op: "like", args: [{ op: "casei", args: [{ property: "name" }] }, { op: "casei", args: ["stra%"] }] },
        { op: "t_after", args: [{ property: "at" }, { timestamp: "2022-12-31T00:00:00Z" }] },
      ],
    };
    const fromText = await read(query("ora-kitchen_sink", { filter: text, "filter-lang": "cql2-text" }));
    const fromJson = await read(query("ora-kitchen_sink", { filter: json }));
    assert.deepEqual(fromJson.features.map((f: { id: number }) => f.id), [1, 2, 23]);
    assert.deepEqual(fromText.features.map((f: { id: number }) => f.id), [1, 2, 23]);
    assert.equal(fromJson.numberMatched, 3);
  });

  it("page with limit and offset", async (t) => {
    if (skip) return t.skip(skip);
    const page = await read(query("ora-kitchen_sink", { filter: { op: ">", args: [{ property: "count" }, 10] }, limit: 3, offset: 2 }));
    assert.deepEqual(page.features.map((f: { id: number }) => f.id), [16, 18, 19]);
    assert.equal(page.numberMatched, 10);
  });

  it("refuse a property the table doesn't have; answer spatial filters", async (t) => {
    if (skip) return t.skip(skip);
    const unknown = await query("ora-kitchen_sink", { filter: { op: "=", args: [{ property: "STATE_NAME" }, "Texas"] } });
    assert.equal(unknown.status, 400);
    assert.equal((await read(unknown)).problems[0].code, "unknown-property");
    const spatial = await read(query("ora-kitchen_sink", { filter: "S_WITHIN(geometry, BBOX(0, 0, 6, 6))", "filter-lang": "cql2-text" }));
    assert.deepEqual(spatial.features.map((f: { id: number }) => f.id), [2, 5, 6, 8, 13, 20, 21, 22]); // not 12 (0 0) or 23 (5 6): on its boundary
  });
});

/**
 * What the kitchen sink doesn't hold: values finer than its columns (sub-millisecond instants, years before 1), text
 * that needs Unicode's full normalization, and sessions whose NLS settings would change the answers. Each SQL answer is
 * checked against evaluate's on the value the dialect serves.
 */
describe("the oracle dialect on values and sessions the kitchen sink doesn't have", () => {
  /** A connection of its own, with the session settings given (the pool's connections keep theirs). */
  const session = async <T>(settings: string, body: (c: oracledb.Connection) => Promise<T>): Promise<T> => {
    const c = await oracledb.getConnection({ connectString: process.env.ORACLE_CONNECT, user: process.env.ORACLE_USER, password: process.env.ORACLE_PASSWORD });
    try {
      if (settings) await c.execute(`ALTER SESSION SET ${settings}`);
      return await body(c);
    } finally {
      await c.close();
    }
  };
  /**
   * The value served for `x` (an SQL expression of the column's type), and whether toSql's filter, and its negation
   * (`{ op: "not" }`, never `NOT (…)` around the SQL), select it, beside evaluate's answers on the served value.
   */
  const check = async (c: oracledb.Connection, x: string, column: SqlColumn, filter: Cql2Filter) => {
    const selects = async (f: Cql2Filter) => {
      const { where, params } = toSql(f, { dialect: "oracle", columns: { x: column } });
      const rows = (await c.execute<[unknown, number]>(`SELECT ${oracleValue("x", column)}, CASE WHEN ${where} THEN 1 ELSE 0 END FROM (SELECT ${x} AS "x" FROM dual)`, [...params])).rows!;
      return rows[0]!;
    };
    const negation = { op: "not", args: [filter] } as Cql2Filter;
    const [[served, selected], [, negated]] = [await selects(filter), await selects(negation)];
    const evaluate = (f: Cql2Filter) => (toPredicate(f, { queryables: { x: column } })({ properties: { x: served } }) ? 1 : 0);
    return { served, sql: [selected, negated], evaluate: [evaluate(filter), evaluate(negation)] };
  };
  const TZ: SqlColumn = { type: "string", format: "date-time", sqlType: "TIMESTAMP(6) WITH TIME ZONE" };
  const DAY: SqlColumn = { type: "string", format: "date", sqlType: "DATE" };
  const NUMBER: SqlColumn = { type: "number", sqlType: "NUMBER" };
  const TEXT: SqlColumn = { type: "string", sqlType: "VARCHAR2" };

  it("instants truncated to milliseconds (as served), in UTC whatever the session's time zone", async (t) => {
    if (skip) return t.skip(skip);
    await session("TIME_ZONE = '+05:30'", async (c) => {
      const x = "TIMESTAMP '2023-01-01 05:30:00.999600 +05:30'";
      const at = (timestamp: string, op = "="): Cql2Filter => ({ op, args: [{ property: "x" }, { timestamp }] } as Cql2Filter);
      assert.deepEqual(await check(c, x, TZ, at("2023-01-01T00:00:00.999Z")), { served: "2023-01-01T00:00:00.999Z", sql: [1, 0], evaluate: [1, 0] });
      assert.deepEqual(await check(c, x, TZ, at("2023-01-01T00:00:01Z", "<")), { served: "2023-01-01T00:00:00.999Z", sql: [1, 0], evaluate: [1, 0] });
      // Before 1582 Oracle's calendar is Julian: compared as text, the answer is still evaluate's.
      const old = "TIMESTAMP '1000-03-01 00:00:00 +00:00'";
      assert.deepEqual(await check(c, old, TZ, at("1000-02-28T00:00:00Z", ">")), { served: "1000-03-01T00:00:00.000Z", sql: [1, 0], evaluate: [1, 0] });
    });
  });

  it("a DATE before year 1 is served with its sign: no day, so NULL, as in evaluate", async (t) => {
    if (skip) return t.skip(skip);
    await session("", async (c) => {
      const filter = { op: "<", args: [{ property: "x" }, { date: "2020-01-01" }] } as Cql2Filter;
      // NULL: neither the filter nor its negation selects it.
      assert.deepEqual(await check(c, "TO_DATE('-0044-03-15', 'SYYYY-MM-DD')", DAY, filter), { served: "-0044-03-15", sql: [0, 0], evaluate: [0, 0] });
    });
  });

  it("numbers exact under another decimal separator; text in code point order under a linguistic sort", async (t) => {
    if (skip) return t.skip(skip);
    await session("NLS_NUMERIC_CHARACTERS = ',.' NLS_COMP = LINGUISTIC NLS_SORT = GERMAN_CI", async (c) => {
      for (const v of [2.5, 1e-7, 0.1, 12345.678]) {
        assert.deepEqual(await check(c, `CAST(${v} AS NUMBER)`, NUMBER, { op: "=", args: [{ property: "x" }, v] }), { served: v, sql: [1, 0], evaluate: [1, 0] });
      }
      assert.deepEqual(await check(c, "'a'", TEXT, { op: "=", args: [{ property: "x" }, "A"] }), { served: "a", sql: [0, 1], evaluate: [0, 1] });
      assert.deepEqual(await check(c, "'ä'", TEXT, { op: "<", args: [{ property: "x" }, "b"] }), { served: "ä", sql: [0, 1], evaluate: [0, 1] });
      assert.deepEqual(await check(c, "'abc'", TEXT, { op: "like", args: [{ property: "x" }, "A%"] }), { served: "abc", sql: [0, 1], evaluate: [0, 1] });
    });
  });

  it("CASEI and ACCENTI end in NFC exactly: marks reordered (even above U+FFFF), composed across a mark", async (t) => {
    if (skip) return t.skip(skip);
    const strings = [
      "\u0106\u0323", // Ć with a dot below: ć composes across the mark below
      "H\u0331", // h + macron below is ẖ, though H + macron below has no composite
      "\u1FA9\u{10F4D}", // ᾩ and a mark above U+FFFF: U+0345 folds to ι after it
      "a\u0301\u{10F4D}", // NFD order: the mark above U+FFFF first
      "\u1100\u1161\u11A8", // Hangul jamo: 각
      "\u1E86\u{1193D}\u{11832}\u{16FF0}", // ACCENTI: two marks left out of order once U+0307 and U+11832 go
      "Straße", "İstanbul", "ΣΊΣΥΦΟΣ",
    ];
    await session("NLS_COMP = LINGUISTIC NLS_SORT = GERMAN_CI", async (c) => {
      for (const fold of ["casei", "accenti"] as const) {
        for (const text of strings) {
          const folded = (await c.execute<[string | null]>(`SELECT cql2_${fold}(:1) FROM dual`, [text])).rows![0]![0];
          // evaluate: the fold of the text equals the result. evaluate reads a literal in NFC, so the result must be
          // in NFC itself: the database compares it as it is.
          const same = toPredicate({ op: "=", args: [{ op: fold, args: [{ property: "x" }] }, folded ?? ""] } as Cql2Filter)({ properties: { x: text } });
          assert.ok(same && folded === folded?.normalize("NFC"), `${fold}(${JSON.stringify(text)}) gave ${JSON.stringify(folded)}`);
        }
      }
      // A value made only of accent marks is '' under ACCENTI in evaluate, NULL in Oracle (documented).
      assert.equal((await c.execute<[string | null]>("SELECT cql2_accenti(:1) FROM dual", ["\u0301"])).rows![0]![0], null);
    });
  });

  it("two lines: they cross at a point, overlap along a stretch, as GEOS decides (cql2_relate's intersection dimension)", async (t) => {
    if (skip) return t.skip(skip);
    const L = (...p: number[][]) => ({ type: "LineString", coordinates: p });
    const lines = [
      L([0, 0], [2, 2]), L([0, 2], [2, 0]), // an X: they cross
      L([0, 0], [2, 0]), L([1, 0], [3, 0]), // collinear, sharing [1, 2]: they overlap
      L([0, 0], [1, 1], [2, 0]), L([0, 0.5], [2, 0.5]), // a V and a line through both arms
      L([0, 0], [2, 0], [2, 2]), L([1, 0], [3, 0], [3, 1], [1, 1]), // a shared stretch, and another meeting
      { type: "MultiLineString", coordinates: [[[0, 0], [1, 0]], [[5, 5], [6, 6]]] },
    ];
    await session("", async (c) => {
      const wrong: string[] = [];
      for (const a of lines) for (const b of lines) for (const op of ["s_overlaps", "s_crosses", "s_touches", "s_within", "s_contains", "s_equals"]) {
        const filter = { op, args: [a, b] } as unknown as Cql2Filter;
        const geos = toPredicate(filter, { spatialEngine: geosEngine })({ properties: {} }) === true;
        const { where, params } = toSql(filter, { dialect: "oracle", columns: {} });
        const oracle = (await c.execute<[number]>(`SELECT CASE WHEN ${where} THEN 1 ELSE 0 END FROM dual`, [...params])).rows![0]![0] === 1;
        if (geos !== oracle) wrong.push(`${op}(${JSON.stringify(a)}, ${JSON.stringify(b)}): GEOS ${geos}, Oracle ${oracle}`);
      }
      assert.deepEqual(wrong, []);
    });
  });
});
