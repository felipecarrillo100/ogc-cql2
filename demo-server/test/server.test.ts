/** Each route on a real server, on a free port, over the states file and a small test collection. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { toPredicate } from "ogc-cql2/evaluate";
import { closeStores, createApp, loadStores } from "../src/server.ts";
import { createGeoJsonStore } from "../src/stores/geojson.ts";
import { loadSpatialite } from "../src/stores/geopackage.ts";

const log: string[] = [];
let server: Server;
let base: string;

before(async () => {
  const stores = await loadStores(fileURLToPath(new URL("../collections.json", import.meta.url)), (line) => log.push(line));
  stores.set(
    "dupes",
    createGeoJsonStore({ id: "dupes", title: "Duplicates" }, {
      type: "FeatureCollection",
      features: [1, 2, 1].map((id) => ({ type: "Feature", id, geometry: null, properties: { id } })),
    }),
  );
  server = createApp(stores, (line) => log.push(line)).listen(0);
  await new Promise((done) => server.once("listening", done));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await closeStores();
});

/** The answer's JSON, whose shape each test checks. */
const read = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

const query = (collection: string, body: unknown): Promise<Response> =>
  fetch(`${base}/collections/${collection}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ids = (answer: { features: { id: unknown }[] }) => answer.features.map((f) => f.id);

describe("collections", () => {
  it("lists them, with warnings", async () => {
    const answer = await read(fetch(`${base}/collections`));
    // The PostgreSQL collections depend on a database being there; their own tests check them.
    const files = answer.collections.filter((c: { source: string }) => c.source !== "postgres");
    assert.deepEqual(
      files.map((c: { id: string; source: string; featureCount: number }) => [c.id, c.source, c.featureCount]),
      [["states", "geojson", 51], ["kitchen_sink", "geojson", 24], ["gpkg-kitchen_sink", "geopackage", 24],
        ["gpkg-states", "geopackage", 51], ["gpkg-sub_regions", "geopackage", 9], ["dupes", "geojson", 2]],
    );
    assert.match(files[5].warnings[0], /Dropped 1 feature/);
    assert.ok(log.includes(`states: 51 features from ${fileURLToPath(new URL("../data/states.geojson", import.meta.url))}`));
  });

  it("describes one, and its queryables as a JSON Schema", async () => {
    assert.equal((await read(fetch(`${base}/collections/states`))).title, "US states");
    const res = await fetch(`${base}/collections/states/queryables`);
    assert.match(res.headers.get("content-type")!, /application\/schema\+json/);
    const schema = await read(res);
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.properties.POP1996, { type: "integer" });
    assert.deepEqual(schema.properties.STATE_NAME, { type: "string" });
  });
});

describe("query", () => {
  it("answers a GeoJSON FeatureCollection with the matching features, the same as evaluate on the file", async () => {
    const filter = { op: ">", args: [{ property: "POP1996" }, 10000000] };
    const res = await query("states", { filter });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /application\/geo\+json/);
    const answer = await read(res);
    const file = JSON.parse(readFileSync(new URL("../data/states.geojson", import.meta.url), "utf8")) as { features: { id: number }[] };
    assert.deepEqual(ids(answer), file.features.filter(toPredicate(filter as never)).map((f) => f.id));
    assert.deepEqual(answer.features.map((f: { properties: { STATE_ABBR: string } }) => f.properties.STATE_ABBR), ["NY", "PA", "CA", "OH", "IL", "TX", "FL"]);
    assert.equal(answer.numberMatched, 7);
    assert.equal(answer.numberReturned, 7);
  });

  it("pages: limit and offset", async () => {
    const answer = await read(query("states", { filter: true, limit: 5, offset: 49 }));
    assert.deepEqual([answer.numberMatched, answer.numberReturned, ids(answer)], [51, 2, [50, 51]]);
    assert.equal((await read(query("states", { filter: true }))).numberReturned, 50);
  });

  it("from the GeoPackage: answered in SQL, with geometry, and a table without geometry", async () => {
    const filter = { op: ">", args: [{ property: "POP1996" }, 10000000] };
    const fromGpkg = await read(query("gpkg-states", { filter }));
    const fromFile = await read(query("states", { filter }));
    assert.deepEqual(ids(fromGpkg), ids(fromFile));
    assert.deepEqual(fromGpkg.features[0].geometry, fromFile.features[0].geometry);
    const west = await read(query("gpkg-sub_regions", { filter: { op: "=", args: [{ property: "region" }, "West"] } }));
    assert.deepEqual(west.features.map((f: { properties: { code: string } }) => f.properties.code), ["Mtn", "Pacific"]);
    assert.equal(west.features[0].geometry, null);
  });

  it("a GeoPackage collection refuses a property it doesn't have", async () => {
    const res = await query("gpkg-sub_regions", { filter: { op: "=", args: [{ property: "STATE_NAME" }, "Texas"] } });
    assert.equal(res.status, 400);
    assert.equal((await read(res)).problems[0].code, "unknown-property");
  });

  it("CASEI and LIKE", async () => {
    const filter = { op: "like", args: [{ op: "casei", args: [{ property: "STATE_NAME" }] }, { op: "casei", args: ["new%"] }] };
    const answer = await read(query("states", { filter }));
    assert.deepEqual(
      answer.features.map((f: { properties: { STATE_NAME: string } }) => f.properties.STATE_NAME).sort(),
      ["New Hampshire", "New Jersey", "New Mexico", "New York"],
    );
  });
});

describe("refusals, as application/problem+json", () => {
  const problem = async (res: Response, status: number, code: string) => {
    assert.equal(res.status, status);
    assert.match(res.headers.get("content-type")!, /application\/problem\+json/);
    const answer = await read(res);
    assert.equal(answer.code, code);
    assert.equal(answer.status, status);
    return answer;
  };

  it("an invalid filter, with validate's problems", async () => {
    const answer = await problem(await query("states", { filter: { op: "=", args: [{ property: "POP1996" }, null] } }), 400, "invalid-filter");
    assert.equal(answer.problems[0].code, "wrong-arguments");
    assert.equal(answer.problems[0].path, "/args/1");
  });

  it("a property that isn't a queryable", async () => {
    const answer = await problem(await query("states", { filter: { op: "=", args: [{ property: "population" }, 1] } }), 400, "invalid-filter");
    assert.equal(answer.problems[0].code, "unknown-property");
    assert.match(answer.problems[0].message, /"population" is not a queryable/);
    assert.equal(answer.problems[0].path, "/args/0");
  });

  it("a spatial filter: the GeoJSON and the GeoPackage collections answer it alike", async () => {
    const filter = { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [-110, 35, -100, 45] }] };
    const answer = await read(query("states", { filter }));
    assert.equal(answer.numberMatched, 11);
    const fromGpkg = await read(query("gpkg-states", { filter }));
    assert.deepEqual(fromGpkg.features.map((f: { properties: { STATE_NAME: string } }) => f.properties.STATE_NAME),
      answer.features.map((f: { properties: { STATE_NAME: string } }) => f.properties.STATE_NAME));
    const notGeometry = await problem(await query("states", { filter: { ...filter, args: [{ property: "POP1996" }, filter.args[1]] } }), 400, "invalid-filter");
    assert.equal(notGeometry.problems[0].code, "type-mismatch");
  });

  it("the other spatial relations: the GeoJSON collection answers them (GEOS), the GeoPackage one too with SpatiaLite", async () => {
    const filter = { op: "s_within", args: [{ property: "geometry" }, { bbox: [-110, 35, -100, 45] }] };
    const answer = await read(query("states", { filter }));
    assert.ok(answer.numberMatched > 0 && answer.numberMatched < 11, `${answer.numberMatched} states wholly inside the box`);
    const names = (a: { features: { properties: { STATE_NAME: string } }[] }) => a.features.map((f) => f.properties.STATE_NAME);
    const { DatabaseSync } = await import("node:sqlite");
    if (loadSpatialite(new DatabaseSync(":memory:", { allowExtension: true }))) {
      assert.deepEqual(names(await read(query("gpkg-states", { filter }))), names(answer));
    } else {
      const refused = await problem(await query("gpkg-states", { filter }), 400, "invalid-filter");
      assert.match(JSON.stringify(refused.problems), /spatial-functions/);
    }
  });

  it("the queryables list the geometry, as OGC API Features Part 3 does", async () => {
    const answer = await read(fetch(`${base}/collections/states/queryables`));
    assert.deepEqual(answer.properties.geometry, { format: "geometry-any" });
  });

  it("a collection without geometry lists none, and refuses a filter on it as an unknown property", async () => {
    assert.equal((await read(fetch(`${base}/collections/gpkg-sub_regions/queryables`))).properties.geometry, undefined);
    const filter = { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [-110, 35, -100, 45] }] };
    const refused = await problem(await query("gpkg-sub_regions", { filter }), 400, "invalid-filter");
    assert.equal(refused.problems[0].code, "unknown-property");
  });

  it("a literal of another type than the queryable's, instead of an empty answer", async () => {
    const answer = await problem(await query("states", { filter: { op: ">", args: [{ property: "POP1996" }, "10000000"] } }), 400, "invalid-filter");
    assert.deepEqual(answer.problems.map((x: { code: string; path: string }) => [x.code, x.path]), [["type-mismatch", "/args/1"]]);
    assert.match(answer.problems[0].message, /"POP1996" is a number: compare it with a number/);
  });

  it("a body without a filter, a bad limit or offset, a body that isn't JSON", async () => {
    await problem(await query("states", {}), 400, "invalid-request");
    await problem(await query("states", { filter: true, limit: 0 }), 400, "invalid-request");
    await problem(await query("states", { filter: true, limit: 1001 }), 400, "invalid-request");
    await problem(await query("states", { filter: true, offset: -1 }), 400, "invalid-request");
    await problem(await query("states", "{bad"), 400, "invalid-json");
  });

  it("an unknown collection or route", async () => {
    await problem(await query("nope", { filter: true }), 404, "unknown-collection");
    await problem(await fetch(`${base}/nothing`), 404, "not-found");
  });

  it("logs each refusal", () => {
    assert.ok(log.includes("POST /collections/states/query → 400 invalid-json"));
  });
});
