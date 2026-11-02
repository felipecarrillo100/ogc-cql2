/**
 * The GeoParquet store (DuckDB): queryables, ids, the geometry column from the `geo` metadata (CRS, edges, encoding),
 * the bbox covering, and the database without its spatial extension. Test files are written by DuckDB, with the `geo`
 * metadata each case needs; the kitchen sink's own file is compared with the other stores in stores-agree.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { openDuckDB, openGeoParquet, type DuckDB } from "../src/stores/duckdb.ts";
import { geometryOf } from "../src/stores/duckdb-columns.ts";

const dir = mkdtempSync(join(tmpdir(), "parquet-test-"));
let duck: DuckDB;
let plain: DuckDB;
before(async () => {
  duck = await openDuckDB();
  plain = await openDuckDB({ spatial: false });
}, { timeout: 120_000 }); // INSTALL downloads the extension on a fresh machine
after(() => {
  duck?.close();
  plain?.close();
  rmSync(dir, { recursive: true, force: true });
});

const COVERING = { bbox: { xmin: ["bbox", "xmin"], ymin: ["bbox", "ymin"], xmax: ["bbox", "xmax"], ymax: ["bbox", "ymax"] } };

/** A GeoParquet file of `select`, with `geo` as its whole `geo` metadata (DuckDB's own left out). */
async function write(name: string, select: string, geo?: object): Promise<string> {
  const file = join(dir, `${name}.parquet`);
  const metadata = geo ? `, GEOPARQUET_VERSION 'NONE', KV_METADATA {geo: '${JSON.stringify(geo).replaceAll("'", "''")}'}` : ", GEOPARQUET_VERSION 'NONE'";
  await duck.rows(`COPY (${select}) TO '${file}' (FORMAT parquet${metadata})`);
  return file;
}
const geoOf = (column: Record<string, unknown>) => ({ version: "1.1.0", primary_column: "geom", columns: { geom: { encoding: "WKB", geometry_types: [], ...column } } });
const ROWS = `SELECT * FROM (VALUES
  (1, 'a', 1.5, true, DATE '2020-01-01', TIMESTAMPTZ '2020-01-01 00:00:00+00', TIMESTAMP '2020-01-01 10:00:00', [1, 2], ST_Point(1, 2)),
  (2, 'b', NULL, false, NULL, NULL, NULL, [], ST_Point(10, 10))
) t(id, name, x, flag, d, t, local, list, geom)`;
const page = { limit: 100, offset: 0 };
const intersects = (bbox: number[]) => ({ op: "s_intersects", args: [{ property: "geometry" }, { bbox }] }) as unknown as Cql2Filter;
const ids = async (store: { query: (f: Cql2Filter, p: typeof page) => Promise<{ features: readonly { id: unknown }[] }> }, filter: Cql2Filter) =>
  (await store.query(filter, page)).features.map((f) => f.id);

describe("a GeoParquet file", () => {
  it("queryables from the column types; id, geometry and a type the dialect can't compare left out, and reported", async () => {
    const store = await openGeoParquet(duck, { id: "t", title: "T", file: await write("types", ROWS, geoOf({})) });
    assert.deepEqual(store.queryables(), {
      name: { type: "string" },
      x: { type: "number" },
      flag: { type: "boolean" },
      d: { type: "string", format: "date" },
      t: { type: "string", format: "date-time" },
      local: { type: "string" },
    });
    assert.match(store.describe().warnings.join(" "), /Column "list" \(INTEGER\[\]\) isn't queryable and isn't served/);
    assert.equal(store.describe().source, "geoparquet");
    assert.equal(store.describe().featureCount, 2);
  });

  it("features: the id column, values as the dialect compares them, geometry decoded", async () => {
    const store = await openGeoParquet(duck, { id: "t", title: "T", file: await write("features", ROWS, geoOf({})) });
    const { features, numberMatched } = await store.query(true, page);
    assert.equal(numberMatched, 2);
    assert.deepEqual(features[0], {
      type: "Feature",
      id: 1,
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { name: "a", x: 1.5, flag: true, d: "2020-01-01", t: "2020-01-01T00:00:00.000Z", local: "2020-01-01T10:00:00.000" },
    });
    assert.deepEqual(await ids(store, intersects([0, 0, 5, 5])), [1]);
    assert.deepEqual((await store.query(true, { limit: 1, offset: 1 })).features.map((f) => f.id), [2]);
  });

  it("another id column, holding text", async () => {
    const file = await write("textid", "SELECT 'k' || id AS key, name, geom FROM (" + ROWS + ")", geoOf({}));
    const store = await openGeoParquet(duck, { id: "t", title: "T", file, idColumn: "key" });
    assert.deepEqual(await ids(store, true), ["k1", "k2"]);
    await assert.rejects(openGeoParquet(duck, { id: "t", title: "T", file }), /has no column "id"; set "idColumn"/);
  });

  it("refuses an id column with duplicates or NULLs", async () => {
    const dupes = await write("dupes", "SELECT * FROM (VALUES (1), (1)) t(id)");
    await assert.rejects(openGeoParquet(duck, { id: "t", title: "T", file: dupes }), /id column "id" has NULLs or duplicates/);
    const nulls = await write("nulls", "SELECT * FROM (VALUES (1), (NULL)) t(id)");
    await assert.rejects(openGeoParquet(duck, { id: "t", title: "T", file: nulls }), /id column "id" has NULLs or duplicates/);
  });

  it("a plain Parquet file: no geometry, nothing to report", async () => {
    const store = await openGeoParquet(duck, { id: "t", title: "T", file: await write("plain", "SELECT id, name FROM (" + ROWS + ")") });
    assert.equal(store.hasGeometry(), false);
    assert.deepEqual(store.describe().warnings, []);
    assert.equal((await store.query(true, page)).features[0]!.geometry, null);
  });
});

describe("the geometry column, from the geo metadata", () => {
  const types = { geom: "GEOMETRY", bbox: "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)" };
  const meta = (column: Record<string, unknown>) => JSON.stringify(geoOf(column));

  it("WGS 84: no crs (CRS84), OGC:CRS84 or EPSG:4326; planar edges", () => {
    for (const crs of [undefined, { id: { authority: "OGC", code: "CRS84" } }, { id: { authority: "EPSG", code: 4326 } }]) {
      assert.deepEqual(geometryOf(meta({ crs, edges: "planar" }), types).column, { sqlType: "GEOMETRY", column: "geom" });
    }
  });

  it("not served, and reported: another CRS, an unknown CRS (null), spherical edges, another encoding, a missing column", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ crs: { id: { authority: "EPSG", code: 3857 } } }, /isn't in WGS 84/],
      [{ crs: null }, /isn't in WGS 84/],
      [{ edges: "spherical" }, /has spherical edges, not planar/],
      [{ encoding: "point" }, /is encoded as point, not WKB/],
    ];
    for (const [column, warning] of cases) {
      const g = geometryOf(meta(column), types);
      assert.equal(g.column, undefined);
      assert.match(g.warnings.join(" "), warning);
    }
    assert.match(geometryOf(meta({}), {}).warnings.join(" "), /"geom" isn't in the file/);
  });

  it("the covering, when its four paths are columns of the file; its column isn't a property", () => {
    const g = geometryOf(meta({ covering: COVERING }), types);
    assert.deepEqual(g.column, { sqlType: "GEOMETRY", column: "geom", covering: COVERING });
    assert.deepEqual(g.hidden, ["geom", "bbox"]);
    const broken = geometryOf(meta({ covering: { bbox: { ...COVERING.bbox, xmax: ["nope", "xmax"] } } }), types);
    assert.deepEqual(broken.column, { sqlType: "GEOMETRY", column: "geom" });
    assert.match(broken.warnings.join(" "), /bbox covering isn't usable/);
  });

  it("a file in another CRS: its features are served without geometry, and spatial filters are refused", async () => {
    const file = await write("mercator", ROWS, geoOf({ crs: { id: { authority: "EPSG", code: 3857 } } }));
    const store = await openGeoParquet(duck, { id: "t", title: "T", file });
    assert.equal(store.hasGeometry(), false);
    assert.equal((await store.query(true, page)).features[0]!.geometry, null);
    assert.match(store.describe().warnings.join(" "), /"geom" isn't in WGS 84 \(CRS84\): features are served without geometry/);
  });

  it("the store compares the covering first: a row whose covering box lies elsewhere isn't selected", async () => {
    // Row 1's point is at (1, 2), its covering box (wrongly) at (50, 50): the covering skips it.
    const select = `SELECT id, geom, CASE id WHEN 1 THEN {xmin: 50, ymin: 50, xmax: 51, ymax: 51}
      ELSE {xmin: ST_XMin(geom), ymin: ST_YMin(geom), xmax: ST_XMax(geom), ymax: ST_YMax(geom)} END AS bbox FROM (${ROWS})`;
    const store = await openGeoParquet(duck, { id: "t", title: "T", file: await write("covering", select, geoOf({ covering: COVERING })) });
    assert.deepEqual(store.queryables(), {});
    assert.deepEqual(await ids(store, intersects([0, 0, 5, 5])), []);
    assert.deepEqual(await ids(store, intersects([0, 0, 20, 20])), [2]);
  });
});

describe("without the spatial extension", () => {
  it("features with their geometry; no spatial classes, and no geometry to filter on", async () => {
    const store = await openGeoParquet(plain, { id: "t", title: "T", file: await write("nospatial", ROWS, geoOf({})) });
    assert.equal(plain.spatial, false);
    assert.equal(store.hasGeometry(), false);
    assert.deepEqual((await store.query(true, page)).features[0]!.geometry, { type: "Point", coordinates: [1, 2] });
    for (const c of [CONFORMANCE.basicSpatial, CONFORMANCE.basicSpatialPlus, CONFORMANCE.spatial]) assert.ok(!store.conformance().includes(c));
    assert.ok(store.conformance().includes(CONFORMANCE.basic));
  });

  it("with it: Spatial Functions too", async () => {
    const store = await openGeoParquet(duck, { id: "t", title: "T", file: await write("spatial", ROWS, geoOf({})) });
    for (const c of [CONFORMANCE.basicSpatial, CONFORMANCE.basicSpatialPlus, CONFORMANCE.spatial]) assert.ok(store.conformance().includes(c));
  });
});
