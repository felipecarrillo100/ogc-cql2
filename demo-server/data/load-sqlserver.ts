/**
 * Loads the kitchen sink into SQL Server (2022 or later), in the database of the connection in ../.env (`MSSQL_SERVER`,
 * `MSSQL_PORT`, `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD`), and creates ogc-cql2's cql2_* functions there
 * (`sqlserverFunctions`), which the sqlserver dialect calls. Safe to run again: it replaces the table.
 *
 * - `dbo.kitchen_sink`, its columns named as the properties, in SQL Server types. The text columns are of three kinds
 *   on purpose: nvarchar with a supplementary-character collation (`name`), varchar in UTF-8 (`code`), and nvarchar in
 *   the database's default collation (`note`). Text is stored in NFC, as the dialect assumes (two values of the file
 *   are in NFD).
 * - `dbo.bin2_text`: an nvarchar column in `Latin1_General_100_BIN2`, which the store leaves out (that collation loses
 *   characters past U+FFFF when converted).
 * - The geometries as `geometry` in SRID 4326, from WKB (exact; the text forms needn't be), with a spatial index:
 *   the kitchen sink's `geom`, and `dbo.states` (`STATE_NAME`, `geom`) from states.geojson.
 *
 * Usage (from demo-server, the package built): node --env-file-if-exists=.env data/load-sqlserver.ts
 */
import { readFileSync } from "node:fs";
import mssql from "mssql";
import { sqlserverFunctions } from "ogc-cql2/sql";
import { createSqlServerPool } from "../src/stores/sqlserver.ts";

type G = { type: string; coordinates?: unknown; geometries?: G[] };
const file = JSON.parse(readFileSync(new URL("./kitchen_sink.geojson", import.meta.url), "utf8")) as {
  features: { id: number; geometry: G | null; properties: Record<string, string | number | boolean | null> }[];
};
const states = JSON.parse(readFileSync(new URL("./states.geojson", import.meta.url), "utf8")) as {
  features: { id: number; geometry: G; properties: { STATE_NAME: string } }[];
};

/** A geometry as ISO WKB (2D, little-endian) in hex; NULL for none. */
function wkb(g: G | null): string | null {
  if (g === null) return null;
  const bytes: number[] = [];
  const u32 = (n: number) => bytes.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const view = new DataView(new ArrayBuffer(8));
  const f64 = (x: number) => { view.setFloat64(0, x, true); for (let i = 0; i < 8; i++) bytes.push(view.getUint8(i)); };
  const point = (p: number[]) => { f64(p[0]!); f64(p[1]!); };
  const points = (ps: number[][]) => { u32(ps.length); ps.forEach(point); };
  const put = (m: G): void => {
    const c = m.coordinates as never;
    bytes.push(1);
    switch (m.type) {
      case "Point": u32(1); point(c); break;
      case "LineString": u32(2); points(c); break;
      case "Polygon": u32(3); u32((c as number[][][]).length); (c as number[][][]).forEach(points); break;
      case "MultiPoint": u32(4); u32((c as unknown[]).length); (c as number[][]).forEach((x) => put({ type: "Point", coordinates: x })); break;
      case "MultiLineString": u32(5); u32((c as unknown[]).length); (c as number[][][]).forEach((x) => put({ type: "LineString", coordinates: x })); break;
      case "MultiPolygon": u32(6); u32((c as unknown[]).length); (c as number[][][][]).forEach((x) => put({ type: "Polygon", coordinates: x })); break;
      default: u32(7); u32(m.geometries!.length); m.geometries!.forEach(put);
    }
  };
  put(g);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}
const fromWkb = (p: string) => `geometry::STGeomFromWKB(CONVERT(varbinary(max), ${p}, 2), 4326)`;

const pool = await createSqlServerPool();
try {
  await pool.request().batch(`DROP TABLE IF EXISTS dbo.kitchen_sink;
CREATE TABLE dbo.kitchen_sink (
  id int PRIMARY KEY,
  name nvarchar(100) COLLATE Latin1_General_100_CI_AS_SC,
  code varchar(40) COLLATE Latin1_General_100_CI_AS_SC_UTF8,
  small smallint,
  count int,
  big bigint,
  ratio float,
  amount decimal(12, 2),
  active bit,
  day date,
  at datetimeoffset(3),
  local_at datetime2(3),
  until datetimeoffset(3),
  note nvarchar(100),
  geom geometry
);
DROP TABLE IF EXISTS dbo.states;
CREATE TABLE dbo.states (id int PRIMARY KEY, STATE_NAME nvarchar(100), geom geometry);`);
  const text = (v: unknown) => (typeof v === "string" ? v.normalize("NFC") : null);
  for (const { id, geometry, properties: p } of file.features) {
    await pool.request()
      .input("id", mssql.Int, id)
      .input("name", mssql.NVarChar(100), text(p.name))
      .input("code", mssql.NVarChar(40), text(p.code))
      .input("small", mssql.SmallInt, p.small)
      .input("count", mssql.Int, p.count)
      .input("big", mssql.BigInt, p.big)
      .input("ratio", mssql.Float, p.ratio)
      .input("amount", mssql.Decimal(12, 2), p.amount)
      .input("active", mssql.Bit, p.active)
      .input("day", mssql.VarChar(10), p.day)
      .input("at", mssql.VarChar(30), p.at)
      .input("local_at", mssql.VarChar(30), p.local_at)
      .input("until", mssql.VarChar(30), p.until)
      .input("note", mssql.NVarChar(100), text(p.note))
      .input("geom", mssql.VarChar(mssql.MAX), wkb(geometry))
      .query(`INSERT INTO dbo.kitchen_sink VALUES (@id, @name, @code, @small, @count, @big, @ratio, @amount, @active,
        CAST(@day AS date), CAST(@at AS datetimeoffset(3)), CAST(@local_at AS datetime2(3)), CAST(@until AS datetimeoffset(3)), @note, ${fromWkb("@geom")})`);
  }
  for (const f of states.features) {
    await pool.request().input("id", mssql.Int, f.id).input("name", mssql.NVarChar(100), f.properties.STATE_NAME).input("geom", mssql.VarChar(mssql.MAX), wkb(f.geometry))
      .query(`INSERT INTO dbo.states VALUES (@id, @name, ${fromWkb("@geom")})`);
  }
  for (const table of ["kitchen_sink", "states"]) {
    await pool.request().batch(`CREATE SPATIAL INDEX ${table}_geom ON dbo.${table} (geom) USING GEOMETRY_AUTO_GRID WITH (BOUNDING_BOX = (-180, -90, 180, 90))`);
  }
  // A table whose nvarchar column is in the one collation that loses characters past U+FFFF: the store leaves it out.
  await pool.request().batch(`DROP TABLE IF EXISTS dbo.bin2_text;
CREATE TABLE dbo.bin2_text (id int PRIMARY KEY, kept nvarchar(20), lost nvarchar(20) COLLATE Latin1_General_100_BIN2);
INSERT INTO dbo.bin2_text VALUES (1, N'a', N'b');`);
  for (const batch of sqlserverFunctions()) await pool.request().batch(batch);
  const [{ n }] = (await pool.request().query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.kitchen_sink")).recordset as [{ n: number }];
  console.log(`kitchen_sink: ${n}; the cql2_* functions created`);
} finally {
  await pool.close();
}
