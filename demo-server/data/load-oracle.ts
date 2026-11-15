/**
 * Loads the kitchen sink into Oracle Database (23ai or later), in the schema of the connection in ../.env
 * (`ORACLE_CONNECT`, `ORACLE_USER`, `ORACLE_PASSWORD`), and creates ogc-cql2's cql2_* functions there
 * (`oracleFunctions`), which the oracle dialect calls. Safe to run again: it replaces the table.
 *
 * - `KITCHEN_SINK`, its columns named as the properties (quoted, in lower case), in Oracle types. Text is stored in NFC,
 *   as the dialect assumes (two values of the file are in NFD); Oracle stores `''` as NULL. `day` is a DATE that holds
 *   days: list it in the store's `days`. Its geometry `geom` is an SDO_GEOMETRY in SRID 4326, with its entry in
 *   USER_SDO_GEOM_METADATA and a spatial index, and the planar index the dialect uses, on `cql2_planar(geom)`.
 * - `KITCHEN_SINK_PLAIN`: the same rows, with neither metadata nor index (its geometry read as CRS84, found without
 *   an index).
 * - `STATES`, from states.geojson: `STATE_NAME` and the geometry, as `KITCHEN_SINK`'s.
 * Geometries are bound as SDO_GEOMETRY objects, their ordinates the file's numbers exactly (Oracle's
 * SDO_UTIL.FROM_GEOJSON keeps 15 significant digits). Rings are stored as Oracle requires them, the exterior counter-clockwise and the holes clockwise (GeoJSON allows
 * either); heights, which GEOS ignores, aren't stored.
 *
 * Usage (from demo-server, the package built): node --env-file-if-exists=.env data/load-oracle.ts
 */
import { readFileSync } from "node:fs";
import oracledb from "oracledb";
import { oracleFunctions } from "ogc-cql2/sql";

type G = { type: string; coordinates?: unknown; geometries?: G[] };
const file = JSON.parse(readFileSync(new URL("./kitchen_sink.geojson", import.meta.url), "utf8")) as {
  features: { id: number; geometry: G | null; properties: Record<string, string | number | boolean | null> }[];
};
const states = JSON.parse(readFileSync(new URL("./states.geojson", import.meta.url), "utf8")) as {
  features: { id: number; geometry: G; properties: { STATE_NAME: string } }[];
};

/** A geometry as Oracle requires it: 2D, the exterior rings counter-clockwise, the holes clockwise. */
function oriented(g: G): G {
  type P = number[];
  const flat = (p: P) => [p[0]!, p[1]!];
  const area = (r: P[]) => r.reduce((sum, p, i) => (i === 0 ? 0 : sum + (r[i - 1]![0]! * p[1]! - p[0]! * r[i - 1]![1]!)), 0);
  const polygon = (rings: P[][]) => rings.map((ring, i) => {
    const r = ring.map(flat);
    return (i === 0) === (area(r) > 0) ? r : r.reverse();
  });
  const c = g.coordinates as never;
  switch (g.type) {
    case "Point": return { type: g.type, coordinates: flat(c) };
    case "LineString": case "MultiPoint": return { type: g.type, coordinates: (c as P[]).map(flat) };
    case "MultiLineString": return { type: g.type, coordinates: (c as P[][]).map((l) => l.map(flat)) };
    case "Polygon": return { type: g.type, coordinates: polygon(c) };
    case "MultiPolygon": return { type: g.type, coordinates: (c as P[][][]).map(polygon) };
    default: return { type: g.type, geometries: g.geometries!.map(oriented) };
  }
}
/**
 * A geometry as the attributes of an SDO_GEOMETRY in SRID 4326, its ordinates the file's numbers (SDO_UTIL.FROM_GEOJSON
 * keeps 15 significant digits); NULL for none or an empty one (Oracle has no empty geometry).
 */
function sdo(geometry: G | null): object | null {
  if (geometry === null || (geometry.type === "GeometryCollection" ? geometry.geometries!.length === 0 : (geometry.coordinates as unknown[]).length === 0)) return null;
  const elem: number[] = [];
  const ords: number[] = [];
  const add = (etype: number, interpretation: number, points: number[][]) => {
    elem.push(ords.length + 1, etype, interpretation);
    for (const p of points) ords.push(p[0]!, p[1]!);
  };
  const polygon = (rings: number[][][]) => rings.forEach((ring, i) => add(i === 0 ? 1003 : 2003, 1, ring));
  const put = (m: G): number => {
    const c = m.coordinates as never;
    switch (m.type) {
      case "Point": add(1, 1, [c]); return 1;
      case "LineString": add(2, 1, c); return 2;
      case "Polygon": polygon(c); return 3;
      case "MultiPoint": add(1, (c as unknown[]).length, c); return 5;
      case "MultiLineString": (c as number[][][]).forEach((l) => add(2, 1, l)); return 6;
      case "MultiPolygon": (c as number[][][][]).forEach(polygon); return 7;
      default: m.geometries!.forEach(put); return 4;
    }
  };
  const gtype = 2000 + put(oriented(geometry));
  return { SDO_GTYPE: gtype, SDO_SRID: 4326, SDO_POINT: null, SDO_ELEM_INFO: elem, SDO_ORDINATES: ords };
}

const connection = await oracledb.getConnection({
  connectString: process.env.ORACLE_CONNECT,
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
});
try {
  const Sdo = await connection.getDbObjectClass("MDSYS.SDO_GEOMETRY");
  const geometry = (g: G | null) => {
    const attributes = sdo(g);
    return attributes === null ? null : new Sdo(attributes);
  };
  for (const table of ["kitchen_sink", "kitchen_sink_plain", "states"]) await connection.execute(`DROP TABLE IF EXISTS ${table} PURGE`);
  await connection.execute("DELETE FROM user_sdo_geom_metadata WHERE table_name IN ('KITCHEN_SINK', 'STATES')");
  // cql2_planar first: the planar indexes below are built on it.
  for (const statement of oracleFunctions()) await connection.execute(statement);
  const user = (await connection.execute<[string]>("SELECT USER FROM dual")).rows![0]![0];
  await connection.execute(`CREATE TABLE kitchen_sink (
    "id" NUMBER(10) PRIMARY KEY,
    "name" VARCHAR2(100 CHAR),
    "code" VARCHAR2(10 CHAR),
    "small" NUMBER(5),
    "count" NUMBER(10),
    "big" NUMBER(19),
    "ratio" BINARY_DOUBLE,
    "amount" NUMBER(12, 2),
    "active" BOOLEAN,
    "day" DATE,
    "at" TIMESTAMP(3) WITH TIME ZONE,
    "local_at" TIMESTAMP(3),
    "until" TIMESTAMP(3) WITH TIME ZONE,
    "note" VARCHAR2(100 CHAR),
    geom SDO_GEOMETRY
  )`);
  await connection.execute("COMMENT ON TABLE kitchen_sink IS 'Every type and edge case the CQL2 profile can compare'");
  const text = (v: unknown) => (typeof v === "string" ? v.normalize("NFC") : null);
  const instant = (v: unknown) => (typeof v === "string" ? v.replace(/Z$/, "") : null);
  const TS = `'YYYY-MM-DD"T"HH24:MI:SS.FF3'`;
  await connection.executeMany(
    `INSERT INTO kitchen_sink VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, TO_DATE(:10, 'YYYY-MM-DD'),
       FROM_TZ(TO_TIMESTAMP(:11, ${TS}), 'UTC'), TO_TIMESTAMP(:12, ${TS}), FROM_TZ(TO_TIMESTAMP(:13, ${TS}), 'UTC'), :14, :15)`,
    file.features.map(({ id, geometry: g, properties: p }) => [
      id, text(p.name), text(p.code), p.small, p.count, p.big, p.ratio, p.amount, p.active, p.day, instant(p.at),
      instant(p.local_at), instant(p.until), text(p.note), geometry(g),
    ]),
    {
      bindDefs: [
        { type: oracledb.NUMBER }, { type: oracledb.STRING, maxSize: 400 }, { type: oracledb.STRING, maxSize: 40 },
        { type: oracledb.NUMBER }, { type: oracledb.NUMBER }, { type: oracledb.NUMBER },
        { type: oracledb.DB_TYPE_BINARY_DOUBLE }, { type: oracledb.NUMBER }, { type: oracledb.DB_TYPE_BOOLEAN },
        { type: oracledb.STRING, maxSize: 10 }, { type: oracledb.STRING, maxSize: 30 }, { type: oracledb.STRING, maxSize: 30 },
        { type: oracledb.STRING, maxSize: 30 }, { type: oracledb.STRING, maxSize: 400 }, { type: Sdo },
      ],
    },
  );
  await connection.execute("CREATE TABLE kitchen_sink_plain AS SELECT * FROM kitchen_sink");
  await connection.execute("ALTER TABLE kitchen_sink_plain ADD PRIMARY KEY (\"id\")");
  await connection.execute(`CREATE TABLE states ("id" NUMBER(10) PRIMARY KEY, STATE_NAME VARCHAR2(100), geom SDO_GEOMETRY)`);
  await connection.executeMany(
    "INSERT INTO states VALUES (:1, :2, :3)",
    states.features.map((f) => [f.id, f.properties.STATE_NAME, geometry(f.geometry)]),
    { bindDefs: [{ type: oracledb.NUMBER }, { type: oracledb.STRING, maxSize: 400 }, { type: Sdo }] },
  );
  for (const table of ["KITCHEN_SINK", "STATES"]) {
    await connection.execute(`INSERT INTO user_sdo_geom_metadata (table_name, column_name, diminfo, srid) VALUES ('${table}', 'GEOM',
      SDO_DIM_ARRAY(SDO_DIM_ELEMENT('Longitude', -180, 180, 0.05), SDO_DIM_ELEMENT('Latitude', -90, 90, 0.05)), 4326)`);
    await connection.execute(`CREATE INDEX ${table}_geom ON ${table} (geom) INDEXTYPE IS MDSYS.SPATIAL_INDEX_V2`);
    // The planar index the oracle dialect uses (SqlColumn.spatialIndex); the geodetic one above loses planar candidates.
    await connection.execute(`INSERT INTO user_sdo_geom_metadata (table_name, column_name, diminfo, srid) VALUES ('${table}', '${user}.CQL2_PLANAR(GEOM)',
      SDO_DIM_ARRAY(SDO_DIM_ELEMENT('X', -180, 180, 1e-10), SDO_DIM_ELEMENT('Y', -90, 90, 1e-10)), NULL)`);
    await connection.execute(`CREATE INDEX ${table}_planar ON ${table} (cql2_planar(geom)) INDEXTYPE IS MDSYS.SPATIAL_INDEX_V2`);
  }
  await connection.commit();
  const errors = (await connection.execute("SELECT name, line, text FROM user_errors")).rows ?? [];
  if (errors.length > 0) throw new Error(`oracleFunctions: ${JSON.stringify(errors)}`);
  for (const table of ["kitchen_sink", "kitchen_sink_plain", "states"]) {
    console.log(`${table}: ${(await connection.execute<[number]>(`SELECT COUNT(*) FROM ${table}`)).rows![0]![0]}`);
  }
  console.log("the cql2_* functions created");
} finally {
  await connection.close();
}
