/**
 * The PostgreSQL store: queryables from the declared types, ids, geometry, what it refuses to serve, and the routes on
 * its collections. Runs against the database in `.env` with `cql2demo` loaded (load-postgres.sh); skipped otherwise.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { postgresValue, toSql, type SqlColumn } from "ogc-cql2/sql";
import { closeStores, createApp, loadStores } from "../src/server.ts";
import { createPool, openPostgres } from "../src/stores/postgres.ts";
import type { Store } from "../src/stores/types.ts";

let pool: ReturnType<typeof createPool> | undefined;
let skip = "";
const opened: Record<string, Store> = {};
let warnings: string[] = [];
let server: Server | undefined;
let base = "";

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
      tables: [
        { table: "cql2demo.kitchen_sink" },
        { table: "cql2demo.states", title: "US states" },
        { table: "cql2demo.no_such_table" },
        { table: "cql2demo.cql2_casefold" }, // its primary key is text: served, with string ids
      ],
    });
    for (const { id, store } of result.stores) opened[id] = store;
    warnings = result.warnings;
    if (!opened["t-kitchen_sink"]) skip = `cql2demo isn't loaded (${warnings.join(" ")})`;
  } catch (error) {
    skip = `PostgreSQL isn't reachable: ${(error as Error).message}`;
  }
  if (skip) return;
  const stores = await loadStores(fileURLToPath(new URL("../collections.json", import.meta.url)), () => {});
  server = createApp(stores, () => {}).listen(0);
  await new Promise((done) => server!.once("listening", done));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server?.close();
  await pool?.end();
  await closeStores();
});

/** The answer's JSON, whose shape each test checks. */
const read = async (res: Response | Promise<Response>): Promise<any> => (await res).json();
const query = async (collection: string, body: unknown): Promise<Response> =>
  (await fetch(`${base}/collections/${collection}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("the PostgreSQL store", () => {
  it("queryables from the declared PostgreSQL types", (t) => {
    if (skip) return t.skip(skip);
    assert.deepEqual(opened["t-kitchen_sink"]!.queryables(), {
      name: { type: "string" }, // text
      code: { type: "string" }, // character varying(10)
      small: { type: "integer" }, // smallint
      count: { type: "integer" },
      big: { type: "integer" }, // bigint, served as a number
      ratio: { type: "number" }, // double precision
      amount: { type: "number" }, // numeric(12,2)
      active: { type: "boolean" },
      day: { type: "string", format: "date" },
      at: { type: "string", format: "date-time" }, // timestamptz
      local_at: { type: "string" }, // timestamp without time zone: no offset, not an instant
      until: { type: "string", format: "date-time" }, // timestamptz
      note: { type: "string" },
    });
  });

  it("features: the primary key as id, PostGIS geometry, values as the dialect compares them", async (t) => {
    if (skip) return t.skip(skip);
    const { features } = await opened["t-kitchen_sink"]!.query({ op: "=", args: [{ property: "name" }, "Straße"] }, { limit: 10, offset: 0 });
    assert.deepEqual(features, [{
      type: "Feature",
      id: 1,
      geometry: { type: "Point", coordinates: [4.35, 50.85] },
      properties: {
        name: "Straße", code: "100%", small: 1, count: 5, big: 9007199254740991, ratio: 2.5, amount: 12.34, active: true,
        day: "2020-07-26", at: "2023-01-01T00:00:00.000Z", local_at: "2023-01-01T10:00:00.000", until: "2023-12-31T23:59:59.999Z",
        note: "2020-07-26",
      },
    }]);
  });

  it("titles from the config, else the table name; a text primary key gives string ids", async (t) => {
    if (skip) return t.skip(skip);
    assert.equal(opened["t-states"]!.describe().title, "US states");
    assert.equal(opened["t-kitchen_sink"]!.describe().title, "kitchen_sink");
    const { features } = await opened["t-cql2_casefold"]!.query({ op: "=", args: [{ property: "to_text" }, "ss"] }, { limit: 10, offset: 0 });
    assert.deepEqual(features.map((f) => f.id), ["ß", "ẞ"]);
  });

  it("reports a table it can't find, and missing cql2_* functions", async (t) => {
    if (skip) return t.skip(skip);
    assert.ok(warnings.some((w) => /Table "cql2demo.no_such_table" not served: there is no such table/.test(w)));
    const elsewhere = await openPostgres(pool!, { functionSchema: "public", tables: [] });
    assert.match(elsewhere.warnings.join(" "), /The cql2_\* functions aren't in schema "public"/);
  });
});

describe("the routes on the PostgreSQL collections", () => {
  it("list them, with the source", async (t) => {
    if (skip) return t.skip(skip);
    const answer = await read(fetch(`${base}/collections`));
    const pg = answer.collections.filter((c: { source: string }) => c.source === "postgres");
    assert.deepEqual(pg.map((c: { id: string; featureCount: number }) => [c.id, c.featureCount]), [
      ["pg-states", 51], ["pg-sub_regions", 9], ["pg-kitchen_sink", 24], ["pg-kitchen_sink_3857", 24], ["pg-arrays", 13],
    ]);
  });

  it("answer as the GeoJSON states do, geometry included", async (t) => {
    if (skip) return t.skip(skip);
    const filter = { op: ">", args: [{ property: "POP1996" }, 10000000] };
    const fromPg = await read(query("pg-states", { filter }));
    const fromFile = await read(query("states", { filter }));
    assert.deepEqual(fromPg.features.map((f: { id: number }) => f.id), fromFile.features.map((f: { id: number }) => f.id));
    assert.deepEqual(fromPg.features[0].geometry, fromFile.features[0].geometry);
    assert.equal(fromPg.numberMatched, 7);
  });

  it("answer a CQL2-text filter as its CQL2-JSON", async (t) => {
    if (skip) return t.skip(skip);
    const text = "CASEI(STATE_NAME) LIKE CASEI('new%') OR S_INTERSECTS(geometry, POINT(-97.7 30.3))";
    const json = {
      op: "or",
      args: [
        { op: "like", args: [{ op: "casei", args: [{ property: "STATE_NAME" }] }, { op: "casei", args: ["new%"] }] },
        { op: "s_intersects", args: [{ property: "geometry" }, { type: "Point", coordinates: [-97.7, 30.3] }] },
      ],
    };
    const fromText = await read(query("pg-states", { filter: text, "filter-lang": "cql2-text" }));
    const fromJson = await read(query("pg-states", { filter: json }));
    assert.equal(fromJson.numberMatched, 5);
    assert.deepEqual(fromText.features.map((f: { id: number }) => f.id), fromJson.features.map((f: { id: number }) => f.id));
  });

  it("refuse a property the table doesn't have", async (t) => {
    if (skip) return t.skip(skip);
    const res = await query("pg-sub_regions", { filter: { op: "=", args: [{ property: "STATE_NAME" }, "Texas"] } });
    assert.equal(res.status, 400);
    assert.equal((await read(res)).problems[0].code, "unknown-property");
  });
});

describe('"filter-crs" on the PostgreSQL store (OGC API Features Part 3, Requirement 8)', () => {
  const EPSG = (code: number) => `http://www.opengis.net/def/crs/EPSG/0/${code}`;
  const R = 6378137; // Web Mercator, as EPSG:3857 defines it
  const mercator = (lon: number, lat: number) => [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
  /** A box, in CRS84 (west, south, east, north), in EPSG:3857 and in EPSG:4326 (latitude first), as text and JSON. */
  const boxes = (w: number, s: number, e: number, n: number) => {
    const [x1, y1] = mercator(w, s);
    const [x2, y2] = mercator(e, n);
    return [
      { crs: undefined, bbox: [w, s, e, n] },
      { crs: EPSG(3857), bbox: [x1!, y1!, x2!, y2!] },
      { crs: EPSG(4326), bbox: [s, w, n, e] },
    ];
  };
  const intersects = (bbox: number[]) => ({ op: "s_intersects", args: [{ property: "geometry" }, { bbox }] });
  const ids = (answer: { features: { id: number }[] }) => answer.features.map((f) => f.id);

  // The request's rows, on the states: a box west of 90° W (latitude first it doesn't fit CRS84: refused before 1.7.0),
  // and one whose latitude-first numbers fit CRS84 by chance (read wrongly without filter-crs).
  const BOXES: [string, [number, number, number, number]][] = [["around Colorado", [-106.3, 36.4, -100.7, 41.6]], ["around Maine", [-70, 44, -69, 45]]];
  for (const [name, box] of BOXES) {
    it(`a box ${name}: the same states in CRS84, EPSG:3857 and EPSG:4326, as text and as JSON`, async (t) => {
      if (skip) return t.skip(skip);
      const answers: number[][] = [];
      for (const { crs, bbox } of boxes(...box)) {
        const crsMember = crs ? { "filter-crs": crs } : {};
        const json = await query("pg-states", { filter: intersects(bbox), ...crsMember });
        const text = await query("pg-states", { filter: `S_INTERSECTS(geometry, BBOX(${bbox.join(", ")}))`, "filter-lang": "cql2-text", ...crsMember });
        assert.equal(json.status, 200, `${crs} JSON`);
        assert.equal(text.status, 200, `${crs} text`);
        answers.push(ids(await read(json)), ids(await read(text)));
      }
      assert.ok(answers[0]!.length > 0);
      for (const answer of answers) assert.deepEqual(answer, answers[0]);
    });
  }

  it("refuses: an unknown CRS, a literal outside EPSG:3857's area, a latitude out of range, a box running backwards", async (t) => {
    if (skip) return t.skip(skip);
    const problem = async (body: Record<string, unknown>) => {
      const res = await query("pg-states", body);
      const answer = await read(res);
      return [res.status, answer.code, answer.problems?.[0]?.path];
    };
    assert.deepEqual(await problem({ filter: intersects([0, 0, 1, 1]), "filter-crs": "http://www.opengis.net/def/crs/OGC/0/does_not_exist" }), [400, "invalid-request", undefined]);
    // Past the antimeridian PostGIS would wrap x to the other side: the server refuses it (the guide's pattern).
    assert.deepEqual(await problem({ filter: intersects([19000000, 0, 21000000, 1000000]), "filter-crs": EPSG(3857) }), [400, "invalid-filter", "/args/1/bbox/2"]);
    assert.deepEqual(await problem({ filter: intersects([95, -106, 96, -105]), "filter-crs": EPSG(4326) }), [400, "invalid-filter", "/args/1/bbox/0"]);
    assert.deepEqual(await problem({ filter: intersects([-11000000, 4000000, -12000000, 5000000]), "filter-crs": EPSG(3857) }), [400, "invalid-filter", "/args/1/bbox"]);
    // Without filter-crs a box in metres is CRS84's, refused (Part 3's Conformance Test 10).
    assert.deepEqual(await problem({ filter: intersects([1000000, 1000000, 2000000, 2000000]) }), [400, "invalid-filter", "/args/1/bbox/0"]);
  });
});

describe("the postgres dialect on values the kitchen sink doesn't have", () => {
  /** The value served for `x` (an SQL expression), and whether toSql's filter and its negation select it, beside evaluate. */
  const check = async (x: string, column: SqlColumn, filter: Cql2Filter) => {
    const selects = async (f: Cql2Filter) => {
      const { where, params } = toSql(f, { dialect: "postgres", columns: { x: column }, functionSchema: "cql2demo" });
      const { rows } = await pool!.query(`SELECT ${postgresValue("x", column)} AS v, CASE WHEN ${where} THEN 1 ELSE 0 END AS s FROM (SELECT ${x} AS x) t`, params);
      return [rows[0].v, rows[0].s] as const;
    };
    const negation = { op: "not", args: [filter] } as Cql2Filter;
    const [[served, selected], [, negated]] = [await selects(filter), await selects(negation)];
    const evaluate = (f: Cql2Filter) => (toPredicate(f, { queryables: { x: column } })({ properties: { x: served } }) ? 1 : 0);
    return { served, sql: [selected, negated], evaluate: [evaluate(filter), evaluate(negation)] };
  };
  const TEXT_INSTANT: SqlColumn = { type: "string", format: "date-time", sqlType: "text" };

  it("a leap second held as text (second 60) is the last millisecond of its minute, as in evaluate", async (t) => {
    if (skip) return t.skip(skip);
    // RFC 3339 allows second 60; no engine's own timestamp type holds it. The package reads it as the last
    // millisecond of its minute, the same as evaluate.
    const at = (op: string, timestamp: string): Cql2Filter => ({ op, args: [{ property: "x" }, { timestamp }] } as Cql2Filter);
    const cases: [string, Cql2Filter][] = [
      ["2016-12-31T23:59:60Z", at("=", "2016-12-31T23:59:59.999Z")], ["2016-12-31T23:59:60Z", at("=", "2016-12-31T23:59:60Z")],
      ["2016-12-31T23:59:60.5Z", at("=", "2016-12-31T23:59:59.999Z")], ["2016-12-31T23:59:60Z", at("<", "2017-01-01T00:00:00Z")],
      ["2016-12-31T23:59:60Z", at(">", "2016-12-31T23:59:59.998Z")], ["2017-01-01T00:59:60+01:00", at("=", "2016-12-31T23:59:59.999Z")],
      ["2016-12-31T23:59:59.999Z", at("=", "2016-12-31T23:59:60Z")], ["2016-12-31T23:59:61Z", at("<", "2017-01-01T00:00:00Z")],
    ];
    for (const [x, filter] of cases) {
      const r = await check(`'${x}'::text`, TEXT_INSTANT, filter);
      assert.deepEqual(r.sql, r.evaluate, `${x} ${JSON.stringify(filter)}`);
    }
  });
});
