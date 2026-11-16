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
import { COLUMNS, ROWS } from "./arrays-rows.ts";

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
