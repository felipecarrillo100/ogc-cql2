/**
 * Writes arrays.gpkg: a GeoPackage 1.4 with the arrays table of arrays.sql, its arrays as TEXT JSON, the way GDAL
 * writes list fields (`application/json` in `gpkg_data_columns`, the Schema extension), for the sqlite dialect's array
 * functions. GeoPackage has no array type and GDAL keeps no element type, so `collections.json` lists the columns
 * with their `items`. The rows hold the values where engines disagree (NULL arrays, NULL elements, repeats, empty
 * arrays, `""`, `"a "`, `"A"`, NFC and NFD, `1` / `1.0`, `-0`, dates and instants as text), GDAL's pretty-printed JSON,
 * JSON that isn't an array or isn't JSON, and where SQLite's own JSON reading parts from JSON.parse (an integer beyond
 * 2^53, a lone surrogate, `\u0000`, `1e400`). Usage, from demo-server: `node data/make-arrays-gpkg.ts`.
 */
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const COLUMNS = ["tags", "codes", "ratios", "counts", "flags", "days", "moments", "doc"] as const;
// id, title, then COLUMNS as stored (JSON text, or NULL)
const ROWS: [number, string, ...(string | null)[]][] = [
  [1, "two strings (as GDAL writes them)", `[ "a", "b" ]`, `[ "a", "b" ]`, `[ 1.0, 2.5 ]`, `[ 1, 2 ]`, `[ true, false ]`, `[ "2010-02-10" ]`,
    `[ "2010-02-10T05:30:00.123Z" ]`, `[ "a", "b" ]`],
  [2, "repeats, another order", `["b","a","a"]`, `["b","a","a"]`, `[2.5, 1, 1]`, `[2, 1, 1]`, `[false, true, true]`, `["2010-02-10", "2010-02-10"]`,
    `["2010-02-10T05:30:00.1234Z", "2010-02-10T05:30:00.123+00:00"]`, `["b", "a", "a"]`],
  [3, "empty", `[]`, `[]`, `[]`, `[]`, `[]`, `[]`, `[]`, `[]`],
  [4, "NULL", null, null, null, null, null, null, null, null],
  [5, "NULL elements", `["a", null]`, `[null]`, `[null, 0.1]`, `[null, 1]`, `[null, true]`, `[null, "2010-02-10"]`, `[null]`, `["a", null]`],
  [6, "the equality traps", `["", "a ", "A"]`, `["1"]`, `[1.0, -0.0, 0.1]`, `[0, -1]`, `[true]`, `["1969-07-16"]`, `["1969-07-16T13:32:00Z"]`,
    `["", "a ", "A", "1", 1, true, 1.0]`],
  [7, "Unicode: NFD é, U+E000, an emoji", `["é", "", "😀"]`, `["é"]`, `[1e300, -1e300]`, `[2147483647]`, `[false]`, `["2010-02-30", "2010-02-10"]`,
    `["not a date"]`, `["é", "é"]`],
  [8, "dates and instants as strings", `["2010-02-10", "2010-02-10T05:30:00.123Z"]`, `["2010-02-10"]`, `[0]`, `[0]`, `[true]`, `["2010-02-10", "1969-07-16"]`,
    `["2010-02-10T00:00:00Z", "2012-08-10T05:30:00+00:00"]`, `["2010-02-10", "2010-02-10T05:30:00.123Z", "2012-08-10T05:30:00+00:00"]`],
  [9, "JSON that isn't an array, or isn't JSON", `"a"`, `{"not": "an array"}`, `5`, `true`, `null`, `not json`, `[1,]`, ``],
  [10, "nested, an object, out of range", `[["a"], "b"]`, `["x"]`, `[[1], 8]`, `[8]`, `[true]`, `["2010-02-11"]`, `["2010-02-11T00:00:00Z"]`,
    `[["a"], {"k": 1}, 1e400, 1e-400, "a"]`],
  [11, "the standard's mixed examples", `["a", "c"]`, `["a"]`, `[1, 8]`, `[1, 8]`, `[true]`, `["2010-02-10"]`, `["2012-08-10T05:30:00Z"]`, `["a", true, 1.0, 8]`],
  [12, "one of each", `["c"]`, `["a "]`, `[2.5]`, `[2]`, `[false]`, `["1969-07-16"]`, `["1969-07-16T13:32:00.0005Z"]`, `[false, "2012-08-10T05:30:00Z", "2010-02-10"]`],
  [13, "where SQLite's JSON reading parts from JSON.parse", String.raw`["a\u0000b", "\ud800"]`, `["b"]`, `[1e400]`, `[9007199254740993, 9007199254740991]`, `[true]`,
    `["2010-02-10"]`, `["2010-02-10T05:30:00.123Z"]`, String.raw`[9007199254740993, "\ud800"]`],
];

/** A GeoPackageBinary point (GeoPackage 2.1.3): `GP`, version 0, flags (little-endian, no envelope), the SRS id, WKB. */
function point(x: number, y: number, srsId: number): Uint8Array {
  const bytes = new Uint8Array(8 + 21);
  const view = new DataView(bytes.buffer);
  bytes.set([0x47, 0x50, 0, 0x01]);
  view.setInt32(4, srsId, true);
  bytes[8] = 1; // WKB little-endian
  view.setUint32(9, 1, true); // Point
  view.setFloat64(13, x, true);
  view.setFloat64(21, y, true);
  return bytes;
}

const WGS84 = `GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]`;

const out = fileURLToPath(new URL("arrays.gpkg", import.meta.url));
rmSync(out, { force: true });
const db = new DatabaseSync(out);
db.exec(`
PRAGMA application_id = 1196444487; -- "GPKG"
PRAGMA user_version = 10400;        -- GeoPackage 1.4.0
CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
  organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE,
  description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
  CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
  srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
  CONSTRAINT uk_gc_table_name UNIQUE (table_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
  CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));
CREATE TABLE gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL,
  scope TEXT NOT NULL, CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name));
CREATE TABLE gpkg_data_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, name TEXT, title TEXT, description TEXT,
  mime_type TEXT, constraint_name TEXT, CONSTRAINT pk_gdc PRIMARY KEY (table_name, column_name), CONSTRAINT gdc_tn UNIQUE (table_name, name));
CREATE TABLE gpkg_data_column_constraints (constraint_name TEXT NOT NULL, constraint_type TEXT NOT NULL, value TEXT, min NUMERIC,
  min_is_inclusive BOOLEAN, max NUMERIC, max_is_inclusive BOOLEAN, description TEXT,
  CONSTRAINT gdcc_ntv UNIQUE (constraint_name, constraint_type, value));
CREATE TABLE arrays (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, geom POINT, title TEXT, ${COLUMNS.map((c) => `${c} TEXT`).join(", ")});
`);
db.prepare("INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)").run("WGS 84 geodetic", 4326, "EPSG", 4326, WGS84, "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid");
db.prepare("INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)").run("Undefined cartesian SRS", -1, "NONE", -1, "undefined", "undefined cartesian coordinate reference system");
db.prepare("INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)").run("Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined geographic coordinate reference system");
db.prepare("INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run("arrays", "features", "Arrays", "Arrays as JSON text, as GDAL writes list fields", 0, 0, 12, 12, 4326);
db.prepare("INSERT INTO gpkg_geometry_columns VALUES ('arrays', 'geom', 'POINT', 4326, 0, 0)").run();
const extension = db.prepare("INSERT INTO gpkg_extensions VALUES (?, NULL, 'gpkg_schema', 'http://www.geopackage.org/spec/#extension_schema', 'read-write')");
extension.run("gpkg_data_columns");
extension.run("gpkg_data_column_constraints");
const dataColumn = db.prepare("INSERT INTO gpkg_data_columns (table_name, column_name, name, mime_type) VALUES ('arrays', ?, ?, 'application/json')");
for (const c of COLUMNS) dataColumn.run(c, c);
const insert = db.prepare(`INSERT INTO arrays (id, geom, title, ${COLUMNS.join(", ")}) VALUES (?, ?, ?, ${COLUMNS.map(() => "?").join(", ")})`);
for (const [id, title, ...values] of ROWS) insert.run(id, point(id - 1, id - 1, 4326), title, ...values);
console.log(`arrays.gpkg: ${(db.prepare("SELECT count(*) AS n FROM arrays").get() as { n: number }).n} rows`);
db.close();
