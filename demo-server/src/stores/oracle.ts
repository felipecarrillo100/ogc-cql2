/**
 * Collections read from Oracle Database tables (23ai and later), filtered in the database with `ogc-cql2/sql`'s
 * `oracle` dialect, spatial filters through Oracle Spatial.
 *
 * - The connection comes from `ORACLE_CONNECT` (`host:port/service`), `ORACLE_USER` and `ORACLE_PASSWORD`, which
 *   `npm start` loads from `.env`. The driver is `oracledb` in thin mode: no Oracle client is needed.
 * - Only the tables listed are served, by their names in the data dictionary (`KITCHEN_SINK`, or `OWNER.TABLE`).
 * - The queryables come from the columns' types (`ALL_TAB_COLUMNS`); a DATE column is a date-time with no zone unless
 *   the table lists it in `days`; the id is the primary key (or `id` in the config).
 * - An SDO_GEOMETRY column in SRID 4326 (or with no SRID, read as CRS84) is the geometry, read as the driver's object
 *   and decoded here (`sdoGeometry`): Oracle's TO_GEOJSON keeps 15 digits and TO_WKBGEOMETRY can mis-round. With a
 *   planar spatial index on `cql2_planar(column)`, filters find their candidates through it first (`spatialIndex`). Another SRID: served without
 *   geometry, reported.
 * - Values are selected through `oracleValue`, so what is served is exactly what the SQL compares.
 */
import oracledb from "oracledb";
import type { Cql2Filter } from "ogc-cql2";
import { oracleValue, sqlConformance, toSql, type SqlColumn } from "ogc-cql2/sql";
import { type CollectionDescription, type Feature, type Queryable, type Store } from "./types.ts";

export interface OracleTable {
  /** `TABLE` in the connection's schema, or `OWNER.TABLE`, as the data dictionary names them. */
  readonly table: string;
  /** The id column, when it isn't the (single-column) primary key. */
  readonly id?: string;
  readonly title?: string;
  /** DATE columns that hold days, served as `YYYY-MM-DD` (their time dropped). */
  readonly days?: readonly string[];
}

export interface OracleSource {
  readonly tables: readonly OracleTable[];
  /** Put before each table name (in lower case) to make its collection id. */
  readonly prefix?: string;
  /** Where `oracleFunctions` created the `cql2_*` functions, as the data dictionary names it; default the connection's schema. */
  readonly functionSchema?: string;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const ID = /^[A-Za-z0-9_-]+$/;

/** An Oracle column type → queryable; `undefined` for a type the dialect can't compare. */
function queryableOf(type: string, scale: number | null, day: boolean): Queryable | undefined {
  if (["VARCHAR2", "CHAR", "NVARCHAR2", "NCHAR"].includes(type)) return { type: "string" };
  if (type === "NUMBER") return { type: scale === 0 ? "integer" : "number" };
  if (["FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE"].includes(type)) return { type: "number" };
  if (type === "BOOLEAN") return { type: "boolean" };
  if (type === "DATE") return day ? { type: "string", format: "date" } : { type: "string" }; // no zone: not an instant
  if (/^TIMESTAMP\(\d\) WITH (LOCAL )?TIME ZONE$/.test(type)) return { type: "string", format: "date-time" };
  if (/^TIMESTAMP\(\d\)$/.test(type)) return { type: "string" }; // no zone: not an instant
  return undefined;
}

/** An SDO_GEOMETRY as the driver gives it: its ordinates are numbers, exactly as stored. */
interface SdoObject {
  readonly SDO_GTYPE: number;
  readonly SDO_POINT: { readonly X: number; readonly Y: number } | null;
  readonly SDO_ELEM_INFO: { getValues(): number[] } | null;
  readonly SDO_ORDINATES: { getValues(): number[] } | null;
}

type Position = [number, number];
type GeoJson = { type: string; coordinates?: unknown; geometries?: GeoJson[] };

/**
 * An SDO_GEOMETRY as GeoJSON: points, lines, polygons with holes (rectangles too), their multi types and collections,
 * heights dropped. Arcs and compound elements, which GeoJSON can't hold, are refused.
 */
export function sdoGeometry(g: SdoObject | null): GeoJson | null {
  if (g === null) return null;
  const dims = Math.floor(g.SDO_GTYPE / 1000) || 2;
  const elem = g.SDO_ELEM_INFO?.getValues() ?? [];
  const ords = g.SDO_ORDINATES?.getValues() ?? [];
  if (elem.length === 0) return g.SDO_POINT ? { type: "Point", coordinates: [g.SDO_POINT.X, g.SDO_POINT.Y] } : null;
  const elements: { etype: number; interpretation: number; points: Position[] }[] = [];
  for (let i = 0; i < elem.length; i += 3) {
    const [offset, etype, interpretation] = [elem[i]!, elem[i + 1]!, elem[i + 2]!];
    const end = i + 3 < elem.length ? elem[i + 3]! - 1 : ords.length;
    const points: Position[] = [];
    for (let k = offset - 1; k < end; k += dims) points.push([ords[k]!, ords[k + 1]!]);
    if (![1, 2, 1003, 2003].includes(etype) || (etype !== 1 && ![1, 3].includes(interpretation))) {
      throw new Error(`SDO element type ${etype}, interpretation ${interpretation}: arcs and compound elements aren't served`);
    }
    if (etype % 1000 === 3 && interpretation === 3) { // a rectangle: its corners as a ring
      const [[x1, y1], [x2, y2]] = points as [Position, Position];
      const ring: Position[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
      points.splice(0, 2, ...(etype === 1003 ? ring : ring.reverse()));
    }
    elements.push({ etype, interpretation, points });
  }
  // Each member: a point element (one point, or several: a multipoint), a line, or a polygon and its holes.
  const members: GeoJson[] = [];
  for (const e of elements) {
    if (e.etype === 1) members.push(e.points.length === 1 ? { type: "Point", coordinates: e.points[0] } : { type: "MultiPoint", coordinates: e.points });
    else if (e.etype === 2) members.push({ type: "LineString", coordinates: e.points });
    else if (e.etype === 1003) members.push({ type: "Polygon", coordinates: [e.points] });
    else (members.at(-1)!.coordinates as Position[][]).push(e.points);
  }
  switch (g.SDO_GTYPE % 10) {
    case 1: case 2: case 3: return members[0]!;
    case 5: return { type: "MultiPoint", coordinates: members.flatMap((m) => (m.type === "Point" ? [m.coordinates] : (m.coordinates as Position[]))) };
    case 6: return { type: "MultiLineString", coordinates: members.map((m) => m.coordinates) };
    case 7: return { type: "MultiPolygon", coordinates: members.map((m) => m.coordinates) };
    default: return { type: "GeometryCollection", geometries: members };
  }
}

/** A pool for the environment's connection; numbers come back as JavaScript numbers. */
export function createOraclePool(): Promise<oracledb.Pool> {
  return oracledb.createPool({
    connectString: process.env.ORACLE_CONNECT,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    poolMax: 4,
  });
}

const run = async <T = Record<string, unknown>>(pool: oracledb.Pool, sql: string, binds: unknown[] = []): Promise<T[]> => {
  const connection = await pool.getConnection();
  try {
    const result = await connection.execute<T>(sql, binds as oracledb.BindParameters, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows ?? [];
  } finally {
    await connection.close();
  }
};

/** Makes one store per listed table. A table that can't be served is reported and left out. */
export async function openOracle(
  pool: oracledb.Pool,
  source: OracleSource,
): Promise<{ stores: { id: string; store: Store }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const stores: { id: string; store: Store }[] = [];
  const owner = source.functionSchema ?? (await run<{ U: string }>(pool, "SELECT USER AS u FROM dual"))[0]!.U;
  const functions = await run<{ N: string }>(
    pool,
    "SELECT object_name AS n FROM all_objects WHERE owner = :1 AND object_type = 'FUNCTION' AND object_name IN ('CQL2_CASEI', 'CQL2_ACCENTI', 'CQL2_DAY', 'CQL2_INSTANT', 'CQL2_ARITHMETIC', 'CQL2_RELATE') AND status = 'VALID'",
    [owner],
  );
  if (functions.length < 6) {
    warnings.push(`The cql2_* functions aren't in schema "${owner}": filters using CASEI, ACCENTI, % or ^, dates in text, or geometries, will fail. Run oracleFunctions there (load-oracle.ts does).`);
  }
  for (const entry of source.tables) {
    const name = entry.table.split(".").pop()!;
    const id = `${source.prefix ?? ""}${name.toLowerCase()}`;
    if (!ID.test(id)) {
      warnings.push(`Table "${entry.table}" not served: "${id}" isn't a valid collection id.`);
      continue;
    }
    try {
      stores.push({ id, store: await tableStore(pool, id, entry, source.functionSchema) });
    } catch (error) {
      warnings.push(`Table "${entry.table}" not served: ${(error as Error).message}`);
    }
  }
  return { stores, warnings };
}

async function tableStore(pool: oracledb.Pool, id: string, entry: OracleTable, functionSchema: string | undefined): Promise<Store> {
  const parts = entry.table.split(".");
  const tableName = parts.pop()!;
  const owner = parts[0] ?? (await run<{ U: string }>(pool, "SELECT USER AS u FROM dual"))[0]!.U;
  const relation = `${quote(owner)}.${quote(tableName)}`;
  const columnsInfo = await run<{ NAME: string; TYPE: string; SCALE: number | null }>(
    pool,
    "SELECT column_name AS name, data_type AS type, data_scale AS scale FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id",
    [owner, tableName],
  );
  if (columnsInfo.length === 0) throw new Error("there is no such table (or no permission to see it).");
  const keys = await run<{ NAME: string }>(
    pool,
    `SELECT cc.column_name AS name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
      WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'P'`,
    [owner, tableName],
  );
  const idColumn = entry.id ?? (keys.length === 1 ? keys[0]!.NAME : undefined);
  if (!idColumn || !columnsInfo.some((c) => c.NAME === idColumn)) {
    throw new Error(entry.id ? `it has no column "${entry.id}".` : `it has no single-column primary key; set "id" in the config.`);
  }

  const warnings: string[] = [];
  const geometryInfo = columnsInfo.find((c) => c.TYPE === "SDO_GEOMETRY");
  let geometryColumn: SqlColumn | undefined;
  if (geometryInfo) {
    const [meta] = await run<{ SRID: number | null }>(
      pool, "SELECT srid FROM all_sdo_geom_metadata WHERE owner = :1 AND table_name = :2 AND column_name = :3", [owner, tableName, geometryInfo.NAME],
    );
    // The planar index the dialect uses (SqlColumn.spatialIndex), on cql2_planar(column); not the column's own index,
    // which in SRID 4326 is geodetic and loses planar candidates.
    const [index] = await run<{ N: number }>(
      pool, "SELECT COUNT(*) AS n FROM all_sdo_index_info WHERE table_owner = :1 AND table_name = :2 AND column_name = :3",
      [owner, tableName, `${functionSchema ?? owner}.CQL2_PLANAR(${geometryInfo.NAME})`],
    );
    const srid = meta?.SRID ?? null;
    if (srid === null || srid === 4326) {
      geometryColumn = { sqlType: "SDO_GEOMETRY", column: geometryInfo.NAME, ...(Number(index?.N) > 0 ? { spatialIndex: true } : {}) };
    } else {
      warnings.push(`Its geometry column "${geometryInfo.NAME}" is in SRID ${srid}: features are served without geometry.`);
    }
  }
  const queryables: Record<string, Queryable> = {};
  const columns: Record<string, SqlColumn> = {};
  const days = new Set(entry.days ?? []);
  for (const c of columnsInfo) {
    if (c.NAME === idColumn || c.NAME === geometryInfo?.NAME) continue;
    const q = queryableOf(c.TYPE, c.SCALE, days.has(c.NAME));
    if (!q) {
      warnings.push(`Column "${c.NAME}" (${c.TYPE}) isn't queryable and isn't served.`);
      continue;
    }
    queryables[c.NAME] = q;
    columns[c.NAME] = { ...q, sqlType: c.TYPE };
  }

  const names = Object.keys(columns);
  const select = [
    `${quote(idColumn)} AS "id"`,
    ...(geometryColumn ? [`${oracleValue(geometryColumn.column!, geometryColumn)} AS "geometry"`] : []),
    ...names.map((n) => `${oracleValue(n, columns[n]!)} AS ${quote(n)}`),
  ].join(", ");
  const featureCount = Number((await run<{ N: number }>(pool, `SELECT COUNT(*) AS n FROM ${relation}`))[0]!.N);

  const description: CollectionDescription = { id, title: entry.title ?? tableName.toLowerCase(), source: "oracle", featureCount, warnings };
  const toFeature = (row: Record<string, unknown>): Feature => {
    const properties: Record<string, unknown> = {};
    for (const n of names) properties[n] = row[n];
    return { type: "Feature", id: row.id as string | number, geometry: sdoGeometry((row.geometry ?? null) as SdoObject | null), properties };
  };

  return {
    describe: () => description,
    queryables: () => queryables,
    hasGeometry: () => geometryColumn !== undefined,
    conformance: () => sqlConformance({ dialect: "oracle" }),
    async query(filter: Cql2Filter, { limit, offset }) {
      const filterColumns = geometryColumn && !Object.hasOwn(columns, "geometry") ? { ...columns, geometry: geometryColumn } : columns;
      const { where, params } = toSql(filter, { dialect: "oracle", columns: filterColumns, ...(functionSchema ? { functionSchema } : {}) });
      const n = params.length;
      const [page, count] = await Promise.all([
        run(pool, `SELECT ${select} FROM ${relation} WHERE ${where} ORDER BY ${quote(idColumn)} OFFSET :${n + 1} ROWS FETCH NEXT :${n + 2} ROWS ONLY`, [...params, offset, limit]),
        run<{ N: number }>(pool, `SELECT COUNT(*) AS n FROM ${relation} WHERE ${where}`, [...params]),
      ]);
      return { features: page.map(toFeature), numberMatched: Number(count[0]!.N) };
    },
  };
}
