/**
 * The GeoPackage store: discovery, ids, queryables, booleans, paging, SRS; and the same answers as the GeoJSON store
 * for the same states, on a generated set of filters.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Cql2Filter } from "ogc-cql2";
import { validate } from "ogc-cql2/validate";
import { createGeoJsonStore } from "../src/stores/geojson.ts";
import { openGeoPackage } from "../src/stores/geopackage.ts";

const dir = mkdtempSync(join(tmpdir(), "gpkg-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A GeoPackage point, little-endian, no envelope. */
function point(x: number, y: number, srsId = 4326): Uint8Array {
  const b = new DataView(new ArrayBuffer(8 + 21));
  [0x47, 0x50, 0, 1].forEach((v, i) => b.setUint8(i, v));
  b.setInt32(4, srsId, true);
  b.setUint8(8, 1);
  b.setUint32(9, 1, true);
  b.setFloat64(13, x, true);
  b.setFloat64(21, y, true);
  return new Uint8Array(b.buffer);
}

/** A small GeoPackage with the cases to check. */
function makeGeoPackage(): string {
  const file = join(dir, "test.gpkg");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA application_id = 1196444487;
    CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id INTEGER, definition TEXT);
    INSERT INTO gpkg_spatial_ref_sys VALUES ('WGS 84', 4326, 'EPSG', 4326, ''), ('Web Mercator', 3857, 'EPSG', 3857, '');
    CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, description TEXT, srs_id INTEGER);
    CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z INTEGER, m INTEGER);
    CREATE TABLE things (id INTEGER PRIMARY KEY, geom POINT, flag BOOLEAN, n MEDIUMINT, x DOUBLE, name TEXT(20), d DATE, t DATETIME, data BLOB, odd VARCHAR);
    CREATE TABLE notes (fid INTEGER PRIMARY KEY, text TEXT);
    CREATE TABLE projected (id INTEGER PRIMARY KEY, geom POINT, name TEXT);
    CREATE TABLE nopk (code TEXT PRIMARY KEY, n INTEGER);
    CREATE TABLE "bad name" (id INTEGER PRIMARY KEY);
    CREATE VIEW things_view AS SELECT id AS vid, name FROM things;
    INSERT INTO gpkg_contents VALUES ('things', 'features', 'Things', 'Test features', 4326), ('notes', 'attributes', NULL, '', NULL),
      ('projected', 'features', 'Projected', '', 3857), ('nopk', 'attributes', 'No key', '', NULL), ('bad name', 'attributes', '', '', NULL),
      ('things_view', 'attributes', 'A view', '', NULL), ('tiles', 'tiles', 'Tiles', '', 4326);
    INSERT INTO gpkg_geometry_columns VALUES ('things', 'geom', 'POINT', 4326, 0, 0), ('projected', 'geom', 'POINT', 3857, 0, 0);
  `);
  const insert = db.prepare("INSERT INTO things VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(1, point(1, 2), 1, 10, 1.5, "a", "2020-01-01", "2020-01-01T00:00:00Z", new Uint8Array([1]), "x");
  insert.run(2, point(3, 4), 0, 20, 2.5, "b", "2021-01-01", "2021-01-01T00:00Z", null, null);
  insert.run(3, null, null, null, null, null, null, null, null, null);
  insert.run(4, point(5, 6), 2, 30, 3.5, "c", "2022-01-01", "2022-01-01T12:00:00.5Z", null, null);
  db.prepare("INSERT INTO notes VALUES (?, ?)").run(7, "hello");
  db.prepare("INSERT INTO projected VALUES (?, ?, ?)").run(1, point(100000, 200000, 3857), "p");
  db.close();
  return file;
}

const gpkg = makeGeoPackage();
const all = (filter: unknown = true) => ({ filter: filter as Cql2Filter, page: { limit: 100, offset: 0 } });

describe("discovery from gpkg_contents", () => {
  const { stores, warnings } = openGeoPackage({ file: gpkg, prefix: "t-" });
  const byId = new Map(stores.map((s) => [s.id, s.store]));

  it("serves features and attributes tables and views, with the prefix; not tiles", async () => {
    assert.deepEqual([...byId.keys()].sort(), ["t-notes", "t-projected", "t-things", "t-things_view"]);
  });

  it("reports tables it can't serve, with the reason", async () => {
    assert.ok(warnings.some((w) => /Table "nopk" not served: it has no INTEGER primary key/.test(w)));
    assert.ok(warnings.some((w) => /Table "bad name" not served: "t-bad name" isn't a valid collection id/.test(w)));
  });

  it("titles from identifier, else the table name; the description", async () => {
    assert.equal(byId.get("t-things")!.describe().title, "Things");
    assert.equal(byId.get("t-things")!.describe().description, "Test features");
    assert.equal(byId.get("t-notes")!.describe().title, "notes");
  });

  it("only the listed tables, and an error for a table that isn't there", async () => {
    assert.deepEqual(openGeoPackage({ file: gpkg, tables: ["notes"] }).stores.map((s) => s.id), ["notes"]);
    assert.throws(() => openGeoPackage({ file: gpkg, tables: ["nope"] }), /has no features or attributes table "nope"/);
  });

  it("refuses a file that isn't a GeoPackage", async () => {
    const plain = join(dir, "plain.sqlite");
    new DatabaseSync(plain).exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    assert.throws(() => openGeoPackage({ file: plain }), /is not a GeoPackage/);
  });
});

describe("a features table", () => {
  const things = openGeoPackage({ file: gpkg, tables: ["things"] }).stores[0]!.store;

  it("queryables from GeoPackage's declared types; id, geometry and BLOB excluded; a type outside Table 1 reported", async () => {
    assert.deepEqual(things.queryables(), {
      flag: { type: "boolean" },
      n: { type: "integer" },
      x: { type: "number" },
      name: { type: "string" },
      d: { type: "string", format: "date" },
      t: { type: "string", format: "date-time" },
      odd: {},
    });
    assert.match(things.describe().warnings.join(" "), /Column "odd" is declared VARCHAR, which isn't a GeoPackage type/);
  });

  it("features: the primary key as id, BOOLEAN 0 / 1 as false / true, geometry decoded, no BLOB", async () => {
    const { features } = await things.query(all().filter, all().page);
    assert.deepEqual(features[0], {
      type: "Feature",
      id: 1,
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { flag: true, n: 10, x: 1.5, name: "a", d: "2020-01-01", t: "2020-01-01T00:00:00Z", odd: "x" },
    });
    assert.deepEqual(features.map((f) => f.properties.flag), [true, false, null, 2]);
    assert.equal(features[2]!.geometry, null);
  });

  it("filters in SQL, with paging and numberMatched", async () => {
    const filter = { op: ">", args: [{ property: "n" }, 15] } as const;
    const page = await things.query(filter, { limit: 1, offset: 1 });
    assert.deepEqual([page.numberMatched, page.features.map((f) => f.id)], [2, [4]]);
    assert.deepEqual((await things.query({ op: "=", args: [{ property: "flag" }, true] }, all().page)).features.map((f) => f.id), [1]);
    const dt = { op: ">=", args: [{ property: "t" }, { timestamp: "2021-01-01T00:00:00Z" }] } as const;
    assert.deepEqual((await things.query(dt, all().page)).features.map((f) => f.id), [2, 4]);
  });
});

describe("other tables", () => {
  const { stores } = openGeoPackage({ file: gpkg });
  const get = (id: string) => stores.find((s) => s.id === id)!.store;

  it("an attributes table: no geometry", async () => {
    assert.deepEqual((await get("notes").query(all().filter, all().page)).features, [
      { type: "Feature", id: 7, geometry: null, properties: { text: "hello" } },
    ]);
  });

  it("a table not in WGS 84: served without geometry, and reported", async () => {
    assert.equal((await get("projected").query(all().filter, all().page)).features[0]!.geometry, null);
    assert.match(get("projected").describe().warnings.join(" "), /SRS 3857 \(EPSG 3857\), not WGS 84/);
  });

  it("a view: its first INTEGER column is the id", async () => {
    assert.deepEqual((await get("things_view").query(all().filter, all().page)).features.map((f) => f.id), [1, 2, 3, 4]);
  });
});

describe("the same answers as the GeoJSON store, for the same states", () => {
  const json = JSON.parse(readFileSync(new URL("../data/states.geojson", import.meta.url), "utf8"));
  const fromFile = createGeoJsonStore({ id: "states", title: "US states" }, json);
  const fromGpkg = openGeoPackage({ file: new URL("../data/usa.gpkg", import.meta.url).pathname, tables: ["states"] }).stores[0]!.store;

  it("the same queryables", async () => {
    assert.deepEqual(Object.keys(fromGpkg.queryables()).sort(), Object.keys(fromFile.queryables()).sort());
    for (const [name, q] of Object.entries(fromFile.queryables())) assert.deepEqual(fromGpkg.queryables()[name], q, name);
  });

  const p = (property: string) => ({ property });
  const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
  const filters: unknown[] = [true, false];
  const literals: Record<string, unknown[]> = {
    STATE_NAME: ["Texas", "texas", "New York", "M", ""],
    STATE_ABBR: ["TX", "ny", "W"],
    SUB_REGION: ["Pacific", "Mtn", "N Eng"],
    STATE_FIPS: ["06", "48", "5"],
    AREA: [0, 50000, 100000.5, 1e6],
    POP1990: [1000000, 4866692, 2e7],
    POP1996: [500000, 10000000, 32218713],
  };
  for (const [name, values] of Object.entries(literals)) {
    filters.push({ op: "isNull", args: [p(name)] });
    for (const value of [...values, 5, "5", true]) {
      for (const op of ["=", "<>", "<", "<=", ">", ">="]) filters.push({ op, args: [p(name), value] });
      if (typeof value === "string") {
        filters.push({ op: "=", args: [casei(p(name)), casei(value)] }, { op: "like", args: [p(name), `${value}%`] });
        filters.push({ op: "like", args: [casei(p(name)), casei(`%${value}%`)] });
      }
    }
    filters.push({ op: "in", args: [p(name), values] }, { op: "between", args: [p(name), 0, 5000000] });
  }
  const valid = filters.filter((f) => validate(f).valid) as Cql2Filter[];
  const set = [...valid, ...valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter)];
  for (let i = 0; i + 1 < valid.length; i += 5) set.push({ op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });

  it(`${set.length} filters: the same features, properties and geometries`, async () => {
    const page = { limit: 1000, offset: 0 };
    const differences: string[] = [];
    for (const filter of set) {
      const a = await fromFile.query(filter, page);
      const b = await fromGpkg.query(filter, page);
      // Compared by content: the GeoPackage's columns aren't in the GeoJSON file's property order.
      if (!isDeepStrictEqual(a, b)) {
        differences.push(`${JSON.stringify(filter)}: geojson ${a.features.map((f) => f.id)} / geopackage ${b.features.map((f) => f.id)}`);
      }
    }
    assert.equal(differences.slice(0, 10).join("\n"), "");
    assert.ok(set.length > 400);
  });
});
