/**
 * The SQL Server store: queryables from the declared types, ids, what it refuses to serve, and the routes on its
 * collections; and the sqlserver dialect on values and settings the kitchen sink doesn't have. Runs against the database
 * that `MSSQL_*` names (in `.env`), with the kitchen sink loaded (data/load-sqlserver.ts); skipped otherwise. The
 * server's collections.json doesn't list SQL Server tables yet: the routes are tested on an app made of these stores.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type mssql from "mssql";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { sqlserverValue, toSql, type SqlColumn } from "ogc-cql2/sql";
import { fileURLToPath } from "node:url";
import { closeStores, createApp, loadStores } from "../src/server.ts";
import { createSqlServerPool, openSqlServer } from "../src/stores/sqlserver.ts";
import type { Store } from "../src/stores/types.ts";

let pool: mssql.ConnectionPool | undefined;
let skip = "";
const opened: Record<string, Store> = {};
let warnings: string[] = [];
let server: Server | undefined;
let base = "";

before(async () => {
  if (!process.env.MSSQL_DATABASE) {
    skip = "no MSSQL_DATABASE: add SQL Server's connection to demo-server's .env (see data/load-sqlserver.ts)";
    return;
  }
  try {
    pool = await createSqlServerPool();
    const result = await openSqlServer(pool, {
      prefix: "ms-",
      tables: [{ table: "dbo.kitchen_sink" }, { table: "dbo.bin2_text", title: "Collations" }, { table: "dbo.no_such_table" }],
    });
    for (const { id, store } of result.stores) opened[id] = store;
    warnings = result.warnings;
    if (!opened["ms-kitchen_sink"]) skip = `the kitchen sink isn't loaded in SQL Server (${warnings.join(" ")}): run data/load-sqlserver.ts`;
  } catch (error) {
    skip = `SQL Server isn't reachable: ${(error as Error).message}`;
  }
  if (skip) return;
  server = createApp(new Map([["ms-kitchen_sink", opened["ms-kitchen_sink"]!]]), () => {}).listen(0);
  await new Promise((done) => server!.once("listening", done));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
}, { timeout: 60_000 });
after(async () => {
  server?.close();
  await pool?.close();
});

const read = async (res: Response | Promise<Response>): Promise<any> => (await res).json();
const query = async (collection: string, body: unknown): Promise<Response> =>
  (await fetch(`${base}/collections/${collection}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("the SQL Server store", () => {
  it("queryables from the declared SQL Server types", (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(opened["ms-kitchen_sink"]!.queryables(), {
      name: { type: "string" }, // nvarchar, a supplementary-character collation
      code: { type: "string" }, // varchar, UTF-8
      small: { type: "integer" }, // smallint
      count: { type: "integer" },
      big: { type: "integer" }, // bigint, served as a float
      ratio: { type: "number" }, // float
      amount: { type: "number" }, // decimal(12, 2)
      active: { type: "boolean" }, // bit
      day: { type: "string", format: "date" },
      at: { type: "string", format: "date-time" }, // datetimeoffset
      local_at: { type: "string" }, // datetime2: no zone, not an instant
      until: { type: "string", format: "date-time" },
      note: { type: "string" }, // nvarchar in the database's default collation
    });
  });

  it("features: the primary key as id, values as the dialect compares them", async (t) => {
    if (skip) return t.skip(skip);
    const { features } = await opened["ms-kitchen_sink"]!.query({ op: "=", args: [{ property: "name" }, "Straße"] } as Cql2Filter, { limit: 10, offset: 0 });
    assert.deepEqual(features, [{
      type: "Feature",
      id: 1,
      geometry: { type: "Point", coordinates: [4.35, 50.85] }, // WKB: exact
      properties: {
        name: "Straße", code: "100%", small: 1, count: 5, big: 9007199254740991, ratio: 2.5, amount: 12.34, active: true,
        day: "2020-07-26", at: "2023-01-01T00:00:00.000Z", local_at: "2023-01-01T10:00:00.000", until: "2023-12-31T23:59:59.999Z",
        note: "2020-07-26",
      },
    }]);
  });

  it("leaves out an nvarchar column in Latin1_General_100_BIN2, reports a table it can't find and missing functions", async (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(opened["ms-bin2_text"]!.queryables(), { kept: { type: "string" } });
    assert.match(opened["ms-bin2_text"]!.describe().warnings.join(" "), /Column "lost" \(nvarchar Latin1_General_100_BIN2\) isn't served/);
    assert.equal(opened["ms-bin2_text"]!.describe().title, "Collations");
    assert.ok(warnings.some((w) => /Table "dbo.no_such_table" not served: there is no such table/.test(w)), warnings.join("\n"));
    const elsewhere = await openSqlServer(pool!, { functionSchema: "sys", tables: [] });
    assert.match(elsewhere.warnings.join(" "), /The cql2_\* functions aren't in schema "sys"/);
  });

  it("declares every class but Spatial Functions", (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(opened["ms-kitchen_sink"]!.conformance(), Object.values(CONFORMANCE).filter((c) => c !== CONFORMANCE.spatial));
    assert.equal(opened["ms-kitchen_sink"]!.hasGeometry(), true);
  });
});

describe("collections.json serves the SQL Server collections", () => {
  it("lists them, with their classes", async (t) => {
    if (skip) return t.skip(skip);
    const lines: string[] = [];
    const stores = await loadStores(fileURLToPath(new URL("../collections.json", import.meta.url)), (line) => lines.push(line));
    try {
      const app = createApp(stores, () => {}).listen(0);
      await new Promise((done) => app.once("listening", done));
      try {
        const answer = await read(fetch(`http://localhost:${(app.address() as AddressInfo).port}/collections`));
        const ours = answer.collections.filter((c: { id: string }) => c.id.startsWith("ms-"));
        assert.deepEqual(ours.map((c: { id: string; featureCount: number }) => [c.id, c.featureCount]), [["ms-states", 51], ["ms-kitchen_sink", 24]], lines.join("\n"));
        for (const c of ours) assert.deepEqual(c.conformance, Object.values(CONFORMANCE).filter((c) => c !== CONFORMANCE.spatial));
      } finally {
        app.close();
      }
    } finally {
      await closeStores();
    }
  });
});

describe("the routes on a SQL Server collection", () => {
  it("answer a CQL2-text filter as its CQL2-JSON", async (t) => {
    if (skip) return t.skip(skip);
    const text = "CASEI(name) LIKE CASEI('stra%') AND T_AFTER(at, TIMESTAMP('2022-12-31T00:00:00Z'))";
    const fromText = await read(query("ms-kitchen_sink", { filter: text, "filter-lang": "cql2-text" }));
    assert.deepEqual(fromText.features.map((f: { id: number }) => f.id), [1, 2, 23]);
  });

  it("answer S_INTERSECTS and NOT S_INTERSECTS; refuse S_DISJOINT and the other relations (Spatial Functions)", async (t) => {
    if (skip) return t.skip(skip);
    const box = "BBOX(0, 0, 6, 6)";
    const hits = await read(query("ms-kitchen_sink", { filter: `S_INTERSECTS(geometry, ${box})`, "filter-lang": "cql2-text" }));
    const misses = await read(query("ms-kitchen_sink", { filter: `NOT S_INTERSECTS(geometry, ${box})`, "filter-lang": "cql2-text" }));
    assert.deepEqual(hits.features.map((f: { id: number }) => f.id), [2, 5, 6, 8, 12, 13, 20, 21, 22, 23]);
    assert.equal(hits.numberMatched + misses.numberMatched, 21); // 24 features, 3 without a geometry: NULL, in neither
    for (const relation of ["S_DISJOINT", "S_WITHIN", "S_TOUCHES"]) {
      const res = await query("ms-kitchen_sink", { filter: `${relation}(geometry, ${box})`, "filter-lang": "cql2-text" });
      assert.equal(res.status, 400, relation);
      assert.ok((await read(res)).problems.some((p: { code: string }) => p.code === "needs-conformance"), relation);
    }
  });

  it("page with limit and offset; refuse a property the table doesn't have", async (t) => {
    if (skip) return t.skip(skip);
    const page = await read(query("ms-kitchen_sink", { filter: { op: ">", args: [{ property: "count" }, 10] }, limit: 3, offset: 2 }));
    assert.deepEqual(page.features.map((f: { id: number }) => f.id), [16, 18, 19]);
    assert.equal(page.numberMatched, 10);
    const unknown = await query("ms-kitchen_sink", { filter: { op: "=", args: [{ property: "STATE_NAME" }, "Texas"] } });
    assert.equal(unknown.status, 400);
    assert.equal((await read(unknown)).problems[0].code, "unknown-property");
  });
});

/**
 * What the kitchen sink doesn't hold: blank padding, characters past U+FFFF under LIKE's `_`, sub-millisecond
 * instants, subnormal numbers and overflow, text that needs Unicode's full normalization, a linguistic database
 * language. Each SQL answer, and its negation's, against evaluate's on the value the dialect serves.
 */
describe("the sqlserver dialect on values the kitchen sink doesn't have", () => {
  /** The value served for `x` (an SQL expression), and whether toSql's filter and its negation select it. */
  const check = async (x: string, column: SqlColumn, filter: Cql2Filter) => {
    const selects = async (f: Cql2Filter) => {
      const { where, params } = toSql(f, { dialect: "sqlserver", columns: { x: column } });
      const request = pool!.request();
      params.forEach((v, i) => request.input(`p${i + 1}`, v));
      const [row] = (await request.query(`SELECT ${sqlserverValue("x", column)} AS v, CASE WHEN ${where} THEN 1 ELSE 0 END AS s FROM (SELECT ${x} AS x) t`)).recordset;
      return [row.v, row.s] as const;
    };
    const negation = { op: "not", args: [filter] } as Cql2Filter;
    const [[served, selected], [, negated]] = [await selects(filter), await selects(negation)];
    const evaluate = (f: Cql2Filter) => (toPredicate(f, { queryables: { x: column } })({ properties: { x: served } }) ? 1 : 0);
    return { served, sql: [selected, negated], evaluate: [evaluate(filter), evaluate(negation)] };
  };
  const TEXT: SqlColumn = { type: "string", sqlType: "nvarchar" };
  const f = (op: string, value: unknown) => ({ op, args: [{ property: "x" }, value] }) as Cql2Filter;

  it("text with no blank padding, in comparisons and LIKE: 'a' isn't 'a ', a tab sorts below a space; LIKE's _ is one code point", async (t) => {
    if (skip) return t.skip(skip);
    const cases: [string, Cql2Filter][] = [
      ["N'a '", f("=", "a")], ["N'a'", f("=", "a ")], ["N'a' + NCHAR(9) + N'b'", f("<", "a")], ["N'a'", f("<", "a\tb")],
      ["N'a' + NCHAR(55357) + NCHAR(56832) + N'b'", f("like", "a_b")], ["N'a' + NCHAR(55357) + NCHAR(56832) + N'b'", f("like", "a__b")],
      ["N'x[y]'", f("like", "x[y]")], ["N'xy'", f("like", "x[y]")], ["N'a b'", f("like", "a %")],
      ["N'a '", f("like", "a")], ["N'a '", f("like", "_")], ["N'a '", f("like", "a%")], ["N'a  '", f("like", "%a")],
    ];
    for (const [x, filter] of cases) {
      const r = await check(x, TEXT, filter);
      assert.deepEqual(r.sql, r.evaluate, `${x} ${JSON.stringify(filter)}: served ${JSON.stringify(r.served)}`);
    }
  });

  it("instants truncated to milliseconds, in UTC; subnormal numbers and overflow as evaluate has them", async (t) => {
    if (skip) return t.skip(skip);
    const TZ: SqlColumn = { type: "string", format: "date-time", sqlType: "datetimeoffset" };
    const NUMBER: SqlColumn = { type: "number", sqlType: "float" };
    const at = (ts: string, op = "=") => ({ op, args: [{ property: "x" }, { timestamp: ts }] }) as Cql2Filter;
    const instant = "CAST('2023-01-01T05:30:00.9996+05:30' AS datetimeoffset(7))";
    assert.deepEqual(await check(instant, TZ, at("2023-01-01T00:00:00.999Z")), { served: "2023-01-01T00:00:00.999Z", sql: [1, 0], evaluate: [1, 0] });
    assert.deepEqual(await check(instant, TZ, at("2023-01-01T00:00:01Z", "<")), { served: "2023-01-01T00:00:00.999Z", sql: [1, 0], evaluate: [1, 0] });
    const tiny = "CAST('2.2250738585072014e-308' AS float) / 4"; // a subnormal number, held by SQL Server's float
    for (const filter of [f("=", 2 ** -1024), f(">", 1e-320), f("<", 1e-320), { op: ">", args: [{ op: "*", args: [{ property: "x" }, 1e300] }, 0] } as Cql2Filter,
      { op: "=", args: [{ op: "/", args: [1, { property: "x" }] }, 0] } as Cql2Filter, { op: "<", args: [{ op: "*", args: [{ property: "x" }, 1e-10] }, 1] } as Cql2Filter]) {
      const r = await check(tiny, NUMBER, filter);
      assert.deepEqual(r.sql, r.evaluate, `${JSON.stringify(filter)}: served ${r.served}`);
    }
    for (const filter of [{ op: ">", args: [{ op: "*", args: [{ property: "x" }, 10] }, 0] }, { op: ">", args: [{ op: "+", args: [{ property: "x" }, { property: "x" }] }, 0] },
      { op: ">", args: [{ op: "/", args: [{ property: "x" }, 1e-300] }, 0] }, { op: ">", args: [{ op: "^", args: [{ property: "x" }, 2] }, 0] }] as Cql2Filter[]) {
      const r = await check("CAST('1e308' AS float)", NUMBER, filter); // overflow: NULL, not an error
      assert.deepEqual(r.sql, r.evaluate, JSON.stringify(filter));
    }
  });

  it("geometries: an empty one intersects nothing (FALSE, so its negation holds), a NULL one is NULL; an invalid one fails the query", async (t) => {
    if (skip) return t.skip(skip);
    const GEOMETRY: SqlColumn = { format: "geometry-any", sqlType: "geometry" };
    const answer = async (x: string, filter: Cql2Filter) => {
      const { where, params } = toSql(filter, { dialect: "sqlserver", columns: { x: GEOMETRY } });
      const request = pool!.request();
      params.forEach((v, i) => request.input(`p${i + 1}`, v));
      return (await request.query(`SELECT CASE WHEN ${where} THEN 1 ELSE 0 END AS s FROM (SELECT ${x} AS x) t`)).recordset[0].s;
    };
    const hit = { op: "s_intersects", args: [{ property: "x" }, { bbox: [0, 0, 3, 3] }] } as Cql2Filter;
    const miss = { op: "not", args: [hit] } as Cql2Filter;
    for (const empty of ["geometry::STGeomFromText('POINT EMPTY', 4326)", "geometry::STGeomFromText('GEOMETRYCOLLECTION EMPTY', 4326)"]) {
      assert.deepEqual([await answer(empty, hit), await answer(empty, miss)], [0, 1], empty);
    }
    assert.deepEqual([await answer("CAST(NULL AS geometry)", hit), await answer("CAST(NULL AS geometry)", miss)], [0, 0]);
    // A self-intersecting polygon: SQL Server refuses it (documented: store valid geometries, validate literals).
    await assert.rejects(answer("geometry::STGeomFromText('POLYGON ((0 0, 2 2, 2 0, 0 2, 0 0))', 4326)", hit), /\.NET Framework error/);
  });

  it("CASEI and ACCENTI end in NFC exactly, whatever the database's collation", async (t) => {
    if (skip) return t.skip(skip);
    const strings = ["Ć̣", "H̱", "ᾩ\u{10F4D}", "á\u{10F4D}", "각", "Ẇ\u{1193D}\u{11832}\u{16FF0}", "Straße", "İstanbul", "ΣΊΣΥΦΟΣ", "😀", "a\tb"];
    for (const fold of ["casei", "accenti"] as const) {
      for (const text of strings) {
        const request = pool!.request().input("t", text);
        const [{ r }] = (await request.query(`SELECT dbo.cql2_${fold}(@t) AS r`)).recordset;
        const same = toPredicate({ op: "=", args: [{ op: fold, args: [{ property: "x" }] }, r] } as Cql2Filter)({ properties: { x: text } });
        assert.ok(same && r === r.normalize("NFC"), `${fold}(${JSON.stringify(text)}) gave ${JSON.stringify(r)}`);
      }
    }
  });
});
