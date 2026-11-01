/**
 * The PostgreSQL store: queryables from the declared types, ids, geometry, what it refuses to serve, and the routes on
 * its collections. Runs against the database in `.env` with `cql2demo` loaded (load-postgres.sh); skipped otherwise.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
        day: "2020-07-26", at: "2023-01-01T00:00:00.000Z", local_at: "2023-01-01T10:00:00.000", note: "2020-07-26",
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
      ["pg-states", 51], ["pg-sub_regions", 9], ["pg-kitchen_sink", 24], ["pg-kitchen_sink_3857", 24],
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
