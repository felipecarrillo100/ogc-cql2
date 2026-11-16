/**
 * S_INTERSECTS: ogc-cql2/evaluate on the states' GeoJSON against GEOS (through PostGIS) on the same states, for
 * thousands of generated literals, many placed exactly on the states' vertices and edges, where engines can disagree.
 * Both must select the same states; so must the GeoPackage store (`cql2_intersects` in SQLite) and the PostgreSQL
 * store. The PostgreSQL parts run against the database in `.env` with `cql2demo` loaded; skipped otherwise.
 *
 * The reference is GEOS's DE-9IM matrix: `NOT ST_Relate(geom, literal, 'FF*FF****')`. PostGIS answers `ST_Intersects`
 * (and, from PostGIS 3.7, `ST_Disjoint`) for a point and a polygon with a point-in-polygon test of its own, which on
 * arm64 builds misses a point lying exactly on an edge: its side test is compiled to a fused multiply-add, which
 * rounds differently (measured on PostGIS 3.1–3.7: exact on amd64, 109 misses here on arm64). The test counts those
 * cases too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { toSql, type SqlLiterals } from "ogc-cql2/sql";
import pg from "pg";
import { distance, fromGeoJSON } from "geos.js";
import { geosEngine } from "../src/geos-engine.ts";
import { createOraclePool, openOracle } from "../src/stores/oracle.ts";
import { createSqlServerPool, openSqlServer } from "../src/stores/sqlserver.ts";
import { openGeoPackage } from "../src/stores/geopackage.ts";
import { createPool, openPostgres } from "../src/stores/postgres.ts";
import type { Store } from "../src/stores/types.ts";

type Feature = { properties: { STATE_NAME: string }; geometry: { type: string; coordinates: unknown } };
const states = (JSON.parse(readFileSync(new URL("../data/states.geojson", import.meta.url), "utf8")).features as Feature[]);

let pool: pg.Pool | undefined;
let skip = "";
before(async () => {
  if (!process.env.PGDATABASE) {
    skip = "no PGDATABASE: run the tests with demo-server's .env (npm test does)";
    return;
  }
  pool = new pg.Pool({ max: 2 });
  try {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM cql2demo.states");
    if (rows[0].n !== states.length) skip = `cql2demo.states has ${rows[0].n} rows, the GeoJSON ${states.length}`;
  } catch (error) {
    skip = `PostgreSQL isn't reachable or cql2demo isn't loaded: ${(error as Error).message}`;
  }
});
after(() => pool?.end());

// --- The literals: deterministic, many of them exactly on the states' vertices and edges ---------------------------

let seed = 20261031;
const random = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const between = (a: number, b: number): number => a + (b - a) * random();

/** Every ring of every state, as lists of [x, y]. */
const rings: number[][][] = states.flatMap((f) => {
  const c = f.geometry.coordinates as number[][][] | number[][][][];
  return f.geometry.type === "Polygon" ? (c as number[][][]) : (c as number[][][][]).flat();
});
const vertex = (): number[] => {
  const ring = rings[Math.floor(random() * rings.length)]!;
  return ring[Math.floor(random() * (ring.length - 1))]!;
};
const edge = (): [number[], number[]] => {
  const ring = rings[Math.floor(random() * rings.length)]!;
  const i = Math.floor(random() * (ring.length - 1));
  return [ring[i]!, ring[i + 1]!];
};

type Literal = Record<string, unknown>;
function generate(): Literal[] {
  const out: Literal[] = [];
  const box = (w: number, s: number, e: number, n: number) => out.push({ bbox: [w, s, e, n] });
  for (let i = 0; i < 600; i++) {
    const [x, y] = [between(-180, -60), between(15, 75)];
    const d = [0.01, 0.5, 3, 15][i % 4]!;
    box(x, y, Math.min(x + d, 180), Math.min(y + d, 90));
  }
  for (let i = 0; i < 400; i++) {
    const [x, y] = vertex();
    const d = [0.001, 0.1, 2][i % 3]!;
    box(x!, y!, x! + d, y! + d); // a corner exactly on a vertex
    box(x! - d, y! - d, x!, y!);
  }
  for (let i = 0; i < 600; i++) out.push({ type: "Point", coordinates: vertex() }); // exactly on a vertex
  for (let i = 0; i < 600; i++) {
    const [a, b] = edge();
    out.push({ type: "Point", coordinates: [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2] }); // an edge's midpoint, rounded
    out.push({ type: "LineString", coordinates: [a, b] }); // along an edge
  }
  for (let i = 0; i < 400; i++) {
    const [a, b] = edge();
    const c = [a[0]! + between(-1, 1), a[1]! + between(-1, 1)];
    out.push({ type: "Polygon", coordinates: [[a, b, c, a]] }); // a triangle sharing an edge
    out.push({ type: "LineString", coordinates: [vertex(), vertex()] }); // across states
  }
  for (let i = 0; i < 1500; i++) {
    // Anywhere along an edge, rounded: where a plain floating-point orientation test goes wrong.
    const [a, b] = edge();
    const t = random();
    out.push({ type: "Point", coordinates: [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t] });
  }
  for (let i = 0; i < 200; i++) out.push({ type: "Point", coordinates: [between(-180, -60), between(15, 75)] });
  out.push({ bbox: [170, 50, -170, 60] }, { bbox: [-179, 50, 179, 60] }, { bbox: [150, -90, -150, 90] }); // antimeridian
  out.push({ type: "MultiPoint", coordinates: [vertex(), vertex(), vertex()] });
  out.push({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: vertex() }, { type: "LineString", coordinates: edge() }] });
  for (let i = 0; i < 100; i++) {
    // Collections (GEOS 3.11 can't relate one): a point on an edge, an along-edge line, a triangle sharing an edge.
    const [a, b] = edge();
    const t = random();
    const c = [a[0]! + between(-1, 1), a[1]! + between(-1, 1)];
    out.push({ type: "GeometryCollection", geometries: [
      { type: "Point", coordinates: [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t] },
      { type: "LineString", coordinates: edge() },
      { type: "Polygon", coordinates: [[a, b, c, a]] },
    ] });
  }
  return out;
}
const LITERALS = generate();

/** The same literal for PostGIS: a box as an envelope, across the antimeridian two; else the GeoJSON geometry. */
function postgisCondition(literal: Literal): { sql: string; params: unknown[] } {
  if ("bbox" in literal) {
    const [w, s, e, n] = literal.bbox as number[];
    const env = (a: number, b: number) => `NOT ST_Relate(geom, ST_MakeEnvelope(${a}, ${s}, ${b}, ${n}, 4326), 'FF*FF****')`;
    return { sql: w! > e! ? `(${env(w!, 180)} OR ${env(-180, e!)})` : env(w!, e!), params: [] };
  }
  return { sql: "NOT ST_Relate(geom, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 'FF*FF****')", params: [JSON.stringify(literal)] };
}

describe("S_INTERSECTS: evaluate against PostGIS, on the US states", () => {
  it(`${LITERALS.length} literals select the same states as GEOS`, async (t) => {
    if (skip) return t.skip(skip);
    const differences: string[] = [];
    let selected = 0;
    for (const literal of LITERALS) {
      const filter = { op: "s_intersects", args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
      const ours = states.filter(toPredicate(filter)).map((f) => f.properties.STATE_NAME).sort();
      const { sql, params } = postgisCondition(literal);
      const theirs = (await pool!.query(`SELECT "STATE_NAME" AS n FROM cql2demo.states WHERE ${sql} ORDER BY 1`, params)).rows.map((r) => r.n as string);
      selected += theirs.length;
      if (JSON.stringify(ours) !== JSON.stringify(theirs.sort())) {
        differences.push(`${JSON.stringify(literal).slice(0, 160)}\n    evaluate ${ours.join(", ")} / PostGIS ${theirs.join(", ")}`);
      }
    }
    assert.ok(selected > LITERALS.length, `the literals select states: ${selected} in all`);
    assert.equal(differences.slice(0, 10).join("\n"), "");
  });

  it(`ogc-cql2/sql's postgres dialect, through the PostgreSQL store: the same states as evaluate for every literal`, async (t) => {
    if (skip) return t.skip(skip);
    const storePool = createPool();
    try {
      const { stores } = await openPostgres(storePool, { functionSchema: "cql2demo", tables: [{ table: "cql2demo.states" }] });
      const store = stores[0]!.store as Store;
      const differences: string[] = [];
      for (const literal of LITERALS) {
        const filter = { op: "s_intersects", args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
        const ours = states.filter(toPredicate(filter)).map((f) => f.properties.STATE_NAME).sort();
        const { features } = await store.query(filter, { limit: 100, offset: 0 });
        const theirs = features.map((f) => f.properties.STATE_NAME as string).sort();
        if (JSON.stringify(ours) !== JSON.stringify(theirs)) differences.push(`${JSON.stringify(literal).slice(0, 160)}\n    evaluate ${ours.join(", ")} / sql ${theirs.join(", ")}`);
      }
      assert.equal(differences.slice(0, 10).join("\n"), "");
    } finally {
      await storePool.end();
    }
  });

  it(`ogc-cql2/sql's sqlite dialect, through the GeoPackage store: the same states as evaluate for every literal`, async () => {
    const store = openGeoPackage({ file: new URL("../data/usa.gpkg", import.meta.url).pathname, tables: ["states"] }).stores[0]!.store;
    const differences: string[] = [];
    for (const literal of LITERALS) {
      const filter = { op: "s_intersects", args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
      const ours = states.filter(toPredicate(filter)).map((f) => f.properties.STATE_NAME).sort();
      const { features } = await store.query(filter, { limit: 100, offset: 0 });
      const theirs = features.map((f) => f.properties.STATE_NAME as string).sort();
      if (JSON.stringify(ours) !== JSON.stringify(theirs)) differences.push(`${JSON.stringify(literal).slice(0, 160)}\n    evaluate ${ours.join(", ")} / sql ${theirs.join(", ")}`);
    }
    assert.equal(differences.slice(0, 10).join("\n"), "");
  });

  it("PostGIS's ST_Intersects departs from GEOS only for points exactly on an edge (its point-in-polygon shortcut)", async (t) => {
    if (skip) return t.skip(skip);
    let departures = 0;
    for (const literal of LITERALS.filter((l) => l.type === "Point")) {
      const g = JSON.stringify(literal);
      const { rows } = await pool!.query(
        `SELECT count(*)::int AS n FROM cql2demo.states, (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) q
          WHERE ST_Intersects(geom, q.g) <> NOT ST_Relate(geom, q.g, 'FF*FF****')`, [g]);
      if (rows[0].n === 0) continue;
      departures += rows[0].n;
      // Each departure: GEOS's matrix puts the point on the state's boundary (BI = 0).
      const { rows: m } = await pool!.query(
        `SELECT ST_Relate(geom, q.g) AS m FROM cql2demo.states, (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) q
          WHERE ST_Intersects(geom, q.g) <> NOT ST_Relate(geom, q.g, 'FF*FF****')`, [g]);
      for (const { m: matrix } of m) assert.equal((matrix as string)[3], "0", `${g}: ${matrix}`);
    }
    t.diagnostic(`ST_Intersects departs from GEOS for ${departures} point-state pairs, each a point exactly on the state's boundary`);
  });
});

// --- Spatial Functions: evaluate with GEOS plugged in, against PostGIS -----------------------------------------------

/** PostGIS's answer for each relation, per state: its exact functions, and ST_Relate for the two that take a shortcut. */
const POSTGIS_RELATION = {
  s_equals: "ST_Equals(geom, L)",
  s_touches: "ST_Touches(geom, L)",
  s_within: "ST_Relate(geom, L, 'T*F**F***')", // ST_Within takes the point-in-polygon shortcut
  s_overlaps: "ST_Overlaps(geom, L)",
  s_crosses: "ST_Crosses(geom, L)",
  s_contains: "ST_Relate(geom, L, 'T*****FF*')", // so does ST_Contains
} as const;

/** The literal as one PostGIS geometry: a box as an envelope, across the antimeridian the two halves collected. */
function postgisLiteral(literal: Literal): { sql: string; params: unknown[] } {
  if ("bbox" in literal) {
    const [w, s, e, n] = literal.bbox as number[];
    const env = (a: number, b: number) => `ST_MakeEnvelope(${a}, ${s}, ${b}, ${n}, 4326)`;
    return { sql: w! > e! ? `ST_Collect(${env(w!, 180)}, ${env(-180, e!)})` : env(w!, e!), params: [] };
  }
  return { sql: "ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)", params: [JSON.stringify(literal)] };
}

describe("Spatial Functions: evaluate with GEOS plugged in, against PostGIS, on the US states", () => {
  it(`${Object.keys(POSTGIS_RELATION).length} relations × ${LITERALS.length} literals: the same states`, async (t) => {
    if (skip) return t.skip(skip);
    const differences: string[] = [];
    let selected = 0;
    const columns = Object.entries(POSTGIS_RELATION).map(([r, f]) => `${f} AS ${r}`).join(", ");
    for (const literal of LITERALS) {
      const { sql, params } = postgisLiteral(literal);
      const { rows } = await pool!.query(`SELECT "STATE_NAME" AS n, ${columns.replaceAll("L", "q.l")} FROM cql2demo.states, (SELECT ${sql} AS l) q`, params);
      for (const relation of Object.keys(POSTGIS_RELATION) as (keyof typeof POSTGIS_RELATION)[]) {
        const filter = { op: relation, args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
        const ours = states.filter(toPredicate(filter, { spatialEngine: geosEngine })).map((f) => f.properties.STATE_NAME).sort();
        const theirs = rows.filter((r) => r[relation] === true).map((r) => r.n as string).sort();
        selected += theirs.length;
        if (JSON.stringify(ours) !== JSON.stringify(theirs)) differences.push(`${relation} ${JSON.stringify(literal).slice(0, 120)}\n    evaluate ${ours.join(", ")} / PostGIS ${theirs.join(", ")}`);
      }
    }
    t.diagnostic(`${selected} state-literal pairs selected across the relations`);
    assert.ok(selected > 1000, "the literals select states");
    assert.equal(differences.slice(0, 10).join("\n"), "");
  });

  it(`ogc-cql2/sql's sqlite dialect with SpatiaLite, through the GeoPackage store: all eight relations, the same states as evaluate with GEOS`, async (t) => {
    const store = openGeoPackage({ file: new URL("../data/usa.gpkg", import.meta.url).pathname, tables: ["states"] }).stores[0]!.store;
    if (!store.conformance().includes(CONFORMANCE.spatial)) return t.skip("SpatiaLite (mod_spatialite) isn't installed");
    const differences: string[] = [];
    for (const relation of ["s_disjoint", ...Object.keys(POSTGIS_RELATION)]) {
      for (const literal of LITERALS.filter((_, i) => i % 4 === 0 || (LITERALS[i] as { type?: string }).type === "GeometryCollection")) {
        const filter = { op: relation, args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
        const ours = states.filter(toPredicate(filter, { spatialEngine: geosEngine })).map((f) => f.properties.STATE_NAME).sort();
        const { features } = await store.query(filter, { limit: 100, offset: 0 });
        const theirs = features.map((f) => f.properties.STATE_NAME as string).sort();
        if (JSON.stringify(ours) !== JSON.stringify(theirs)) differences.push(`${relation} ${JSON.stringify(literal).slice(0, 120)}\n    evaluate ${ours.join(", ")} / sql ${theirs.join(", ")}`);
      }
    }
    assert.equal(differences.slice(0, 10).join("\n"), "");
  });

  it(`ogc-cql2/sql's postgres dialect, through the PostgreSQL store: all eight relations, the same states as evaluate with GEOS`, async (t) => {
    if (skip) return t.skip(skip);
    const storePool = createPool();
    try {
      const { stores } = await openPostgres(storePool, { functionSchema: "cql2demo", tables: [{ table: "cql2demo.states" }] });
      const store = stores[0]!.store as Store;
      const differences: string[] = [];
      for (const relation of ["s_disjoint", ...Object.keys(POSTGIS_RELATION)]) {
        for (const literal of LITERALS) {
          const filter = { op: relation, args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
          const ours = states.filter(toPredicate(filter, { spatialEngine: geosEngine })).map((f) => f.properties.STATE_NAME).sort();
          const { features } = await store.query(filter, { limit: 100, offset: 0 });
          const theirs = features.map((f) => f.properties.STATE_NAME as string).sort();
          if (JSON.stringify(ours) !== JSON.stringify(theirs)) differences.push(`${relation} ${JSON.stringify(literal).slice(0, 120)}\n    evaluate ${ours.join(", ")} / sql ${theirs.join(", ")}`);
        }
      }
      assert.equal(differences.slice(0, 10).join("\n"), "");
    } finally {
      await storePool.end();
    }
  });
});

// --- Oracle: the oracle dialect through the Oracle store, against evaluate with GEOS -----------------------------------

/**
 * All eight relations through the Oracle store (its planar index first). Oracle decides with a tolerance (1e-10, its
 * least that holds: see research/oracle), so a geometry within it of a state's boundary may be decided either way: the
 * dialect's one documented deviation. Every difference must be that: a point literal within 1e-10 of the state's
 * boundary, by GEOS's distance. Runs when ORACLE_CONNECT names a database with the states loaded (data/load-oracle.ts).
 */
describe("Spatial Functions: the oracle dialect, through the Oracle store, against evaluate with GEOS, on the US states", () => {
  it(`8 relations × ${LITERALS.length} literals: the same states, but for points within the tolerance of a boundary`, async (t) => {
    if (!process.env.ORACLE_CONNECT) return t.skip("no ORACLE_CONNECT: add Oracle's connection to demo-server's .env (see data/load-oracle.ts)");
    const oraclePool = await createOraclePool();
    try {
      const { stores, warnings } = await openOracle(oraclePool, { tables: [{ table: "STATES" }] });
      const store = stores[0]?.store;
      if (!store) return t.skip(`the states aren't loaded in Oracle (${warnings.join(" ")})`);
      const boundaries = new Map(states.map((f) => {
        const c = f.geometry.coordinates as number[][][] | number[][][][];
        const rings = f.geometry.type === "Polygon" ? (c as number[][][]) : (c as number[][][][]).flat();
        return [f.properties.STATE_NAME, fromGeoJSON({ type: "MultiLineString", coordinates: rings } as never)];
      }));
      const differences: string[] = [];
      let tolerated = 0;
      let farthest = 0;
      for (const relation of ["s_intersects", "s_disjoint", ...Object.keys(POSTGIS_RELATION)]) {
        for (const literal of LITERALS) {
          const filter = { op: relation, args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter;
          const ours = states.filter(toPredicate(filter, { spatialEngine: geosEngine })).map((f) => f.properties.STATE_NAME);
          const { features } = await store.query(filter, { limit: 100, offset: 0 });
          const theirs = features.map((f) => f.properties.STATE_NAME as string);
          for (const state of new Set([...ours, ...theirs])) {
            if (ours.includes(state) === theirs.includes(state)) continue;
            const d = literal.type === "Point" ? distance(fromGeoJSON(literal as never), boundaries.get(state)!) : Infinity;
            if (d <= 1e-10) {
              tolerated++;
              farthest = Math.max(farthest, d);
            } else {
              differences.push(`${relation} ${JSON.stringify(literal).slice(0, 120)} ${state}: evaluate ${ours.includes(state)}, oracle ${theirs.includes(state)}`);
            }
          }
        }
      }
      t.diagnostic(`${tolerated} answers differ for points within ${farthest.toExponential(1)}° of a state's boundary (the documented tolerance)`);
      assert.equal(differences.slice(0, 10).join("\n"), "");
    } finally {
      await oraclePool.close(0);
    }
  });
});

// --- SQL Server: the sqlserver dialect through the SQL Server store, against evaluate with GEOS ------------------------

/**
 * S_INTERSECTS and NOT S_INTERSECTS through the SQL Server store (STDistance <= 0, the spatial index). SQL Server
 * computes on a grid, so a point within rounding of a state's boundary may be decided either way: the dialect's
 * documented deviation. Every difference must be that: a point literal within 1e-10 of the state's boundary, by GEOS's
 * distance. Runs when MSSQL_DATABASE names a database with the states loaded (data/load-sqlserver.ts).
 */
describe("Basic Spatial Functions: the sqlserver dialect, through the SQL Server store, against evaluate, on the US states", () => {
  it(`S_INTERSECTS and NOT S_INTERSECTS × ${LITERALS.length} literals: the same states, but for points within rounding of a boundary`, async (t) => {
    if (!process.env.MSSQL_DATABASE) return t.skip("no MSSQL_DATABASE: add SQL Server's connection to demo-server's .env (see data/load-sqlserver.ts)");
    const sqlServerPool = await createSqlServerPool();
    try {
      const { stores, warnings } = await openSqlServer(sqlServerPool, { tables: [{ table: "dbo.states" }] });
      const store = stores[0]?.store;
      if (!store) return t.skip(`the states aren't loaded in SQL Server (${warnings.join(" ")})`);
      const boundaries = new Map(states.map((f) => {
        const c = f.geometry.coordinates as number[][][] | number[][][][];
        const rings = f.geometry.type === "Polygon" ? (c as number[][][]) : (c as number[][][][]).flat();
        return [f.properties.STATE_NAME, fromGeoJSON({ type: "MultiLineString", coordinates: rings } as never)];
      }));
      const differences: string[] = [];
      let tolerated = 0;
      let farthest = 0;
      for (const negated of [false, true]) {
        for (const literal of LITERALS) {
          const leaf = { op: "s_intersects", args: [{ property: "geometry" }, literal] };
          const filter = (negated ? { op: "not", args: [leaf] } : leaf) as unknown as Cql2Filter;
          const ours = states.filter(toPredicate(filter)).map((f) => f.properties.STATE_NAME);
          const { features } = await store.query(filter, { limit: 100, offset: 0 });
          const theirs = features.map((f) => f.properties.STATE_NAME as string);
          for (const state of new Set([...ours, ...theirs])) {
            if (ours.includes(state) === theirs.includes(state)) continue;
            const d = literal.type === "Point" ? distance(fromGeoJSON(literal as never), boundaries.get(state)!) : Infinity;
            if (d <= 1e-10) {
              tolerated++;
              farthest = Math.max(farthest, d);
            } else {
              differences.push(`${negated ? "NOT " : ""}${JSON.stringify(literal).slice(0, 120)} ${state}: evaluate ${ours.includes(state)}, sqlserver ${theirs.includes(state)}`);
            }
          }
        }
      }
      t.diagnostic(`${tolerated} answers differ for points within ${farthest.toExponential(1)}° of a state's boundary (the documented rounding)`);
      assert.equal(differences.slice(0, 10).join("\n"), "");
    } finally {
      await sqlServerPool.close();
    }
  });
});

// --- Literals in another CRS (SqlOptions.literals, OGC API Features' filter-crs), since 1.7.0 ------------------------

/**
 * Each literal, in CRS84, converted to another CRS by PostGIS (any numbers would do: they are only the input). The
 * postgres dialect with `literals` must select exactly what evaluate (GEOS for the relations) selects with the same
 * numbers converted back to CRS84 by the same PostGIS, vertex by vertex, read back exactly: the conversion a server
 * would do itself, then the comparison in CRS84, as CQL2's. A box in a projected CRS is its four corners converted
 * back, a polygon (`ST_MakeEnvelope`'s ring); in EPSG:4326 latitude first, the same box, axes swapped.
 */
describe("Literals in another CRS: the postgres dialect with literals, as converting first, and against evaluate", () => {
  type Pos = number[];
  /** Converts each position from `from` to `to` in PostGIS, exactly (float8, shortest round trip), heights kept. */
  const convert = async (positions: readonly Pos[], from: number, to: number): Promise<Pos[]> => {
    if (positions.length === 0) return [];
    const { rows } = await pool!.query(
      `SELECT ST_X(p) AS x, ST_Y(p) AS y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(x, y), ${from}), ${to}) AS p, o
         FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS u(x, y, o)) t ORDER BY o`,
      [positions.map((p) => p[0]), positions.map((p) => p[1])],
    );
    return rows.map((r: { x: number; y: number }, i: number) => [r.x, r.y, ...positions[i]!.slice(2)]);
  };
  /** A geometry's positions in order, and the geometry rebuilt from replacements in that order. */
  const positionsOf = (l: Literal): Pos[] => {
    const walk = (c: unknown): Pos[] => (typeof (c as unknown[])[0] === "number" ? [c as Pos] : (c as unknown[]).flatMap(walk));
    return l.type === "GeometryCollection" ? (l.geometries as Literal[]).flatMap(positionsOf) : walk(l.coordinates);
  };
  const rebuild = (l: Literal, next: () => Pos): Literal => {
    const walk = (c: unknown): unknown => (typeof (c as unknown[])[0] === "number" ? next() : (c as unknown[]).map(walk));
    return l.type === "GeometryCollection"
      ? { ...l, geometries: (l.geometries as Literal[]).map((g) => rebuild(g, next)) }
      : { ...l, coordinates: walk(l.coordinates) };
  };
  /** The literal in `srid` (yx: axes swapped), and the reference: its numbers converted back to CRS84 by PostGIS. */
  async function inCrs(l: Literal, srid: number, yx: boolean): Promise<{ given: Literal; reference: Literal } | undefined> {
    const swap = (p: Pos): Pos => (yx ? [p[1]!, p[0]!, ...p.slice(2)] : p);
    if ("bbox" in l) {
      const [w, s, e, n] = l.bbox as number[];
      if (srid === 4326) return { given: { bbox: [s, w, n, e] }, reference: l }; // yx: the box itself, antimeridian included
      if (w! > e!) return undefined; // across the antimeridian: no box in a projected CRS (refused, tested below)
      const [[x1, y1], [x2, y2]] = (await convert([[w!, s!], [e!, n!]], 4326, srid)) as [Pos, Pos];
      const box = [Math.min(x1!, x2!), Math.min(y1!, y2!), Math.max(x1!, x2!), Math.max(y1!, y2!)];
      const corners = await convert([[box[0]!, box[1]!], [box[0]!, box[3]!], [box[2]!, box[3]!], [box[2]!, box[1]!]], srid, 4326);
      return { given: { bbox: box }, reference: { type: "Polygon", coordinates: [[...corners, corners[0]!]] } };
    }
    const forward = srid === 4326 ? positionsOf(l) : await convert(positionsOf(l), 4326, srid);
    const back = srid === 4326 ? forward : await convert(forward, srid, 4326);
    let i = 0;
    let j = 0;
    return { given: rebuild(l, () => swap(forward[i++]!)), reference: rebuild(l, () => back[j++]!) };
  }

  const CRSS = [{ srid: 3857, yx: false }, { srid: 4326, yx: true }, { srid: 32614, yx: false }] as const; // UTM 14N: central US
  const RELATIONS = ["s_intersects", "s_disjoint", ...Object.keys(POSTGIS_RELATION)];
  const columns = { geometry: { sqlType: "geometry", column: "geom" } };

  /**
   * The states each relation selects with `literal`, one query for all eight (each condition a column, its parameters
   * numbered after the previous ones); or the database's error.
   */
  async function selected(literal: Literal, literals?: SqlLiterals): Promise<string[][] | Error> {
    const params: unknown[] = [];
    const conditions = RELATIONS.map((op) => {
      const { where, params: own } = toSql({ op, args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter, {
        dialect: "postgres", columns, ...(literals ? { literals } : {}),
      });
      const offset = params.length;
      params.push(...own);
      return `COALESCE(${where.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`)}, FALSE)`;
    });
    try {
      const { rows } = await pool!.query(
        `SELECT "STATE_NAME" AS name, ${conditions.map((c, k) => `${c} AS r${k}`).join(", ")} FROM cql2demo.states`, params,
      );
      return RELATIONS.map((_, k) => rows.filter((r: Record<string, unknown>) => r[`r${k}`] === true).map((r: { name: string }) => r.name).sort());
    } catch (error) {
      return error as Error;
    }
  }

  /**
   * Two checks a literal. The contract, on every server: the SQL with `literals` selects exactly what the literal
   * converted back gives in plain CRS84 on the same server (what a server converting itself would run), and errors
   * where it errors. And against evaluate with geos.js, failed only on GEOS 3.13 or later: older GEOS (PostGIS 3.1–3.5's
   * images) errors (`TopologyException`) or differs from it on near-coincident geometry, in CRS84 as much (measured:
   * research/filter-crs), so those differences are reported, not failed.
   */
  for (const { srid, yx } of CRSS) {
    it(`SRID ${srid}${yx ? " (yx)" : ""}: 8 relations × ${LITERALS.length} literals, as converting first; and as evaluate`, async (t) => {
      if (skip) return t.skip(skip);
      const { rows: [{ v }] } = await pool!.query("SELECT postgis_geos_version() AS v");
      const [major, minor] = (v as string).split(/[.-]/).map(Number) as [number, number];
      const newGeos = major > 3 || (major === 3 && minor >= 13);
      const contract: string[] = [];
      const differences: string[] = [];
      let [compared, errors] = [0, 0];
      for (const literal of LITERALS) {
        const converted = await inCrs(literal, srid, yx);
        if (!converted) continue;
        const [given, plain] = [await selected(converted.given, { srid, yx }), await selected(converted.reference)];
        const at = JSON.stringify(converted.given).slice(0, 120);
        if (given instanceof Error || plain instanceof Error) {
          if (!(given instanceof Error && plain instanceof Error)) contract.push(`${at}: ${given instanceof Error ? "only with literals" : "only in CRS84"} an error`);
          errors++;
          continue;
        }
        RELATIONS.forEach((op, k) => {
          compared++;
          if (JSON.stringify(given[k]) !== JSON.stringify(plain[k])) contract.push(`${op} ${at}\n    literals ${given[k]!.join(", ")} / CRS84 ${plain[k]!.join(", ")}`);
          const reference = { op, args: [{ property: "geometry" }, converted.reference] } as unknown as Cql2Filter;
          const ours = states.filter(toPredicate(reference, { spatialEngine: geosEngine })).map((f) => f.properties.STATE_NAME).sort();
          if (JSON.stringify(ours) !== JSON.stringify(given[k])) differences.push(`${op} ${at}\n    evaluate ${ours.join(", ")} / sql ${given[k]!.join(", ")}`);
        });
      }
      t.diagnostic(`GEOS ${v}: ${compared} comparisons, ${errors} literals the database errors on (in CRS84 too), ${differences.length} differences from evaluate`);
      assert.ok(compared > 7 * LITERALS.length, `compared ${compared}`);
      assert.equal(contract.slice(0, 10).join("\n"), "");
      if (newGeos) {
        assert.equal(errors, 0);
        assert.equal(differences.slice(0, 10).join("\n"), "");
      }
    });
  }

  it("two literals in 3857: decided by PostGIS in CRS84, as evaluate decides the two converted back", async (t) => {
    if (skip) return t.skip(skip);
    const differences: string[] = [];
    let compared = 0;
    // First a pair where the two planes disagree: (−50, 45) is above the triangle's long edge in CRS84 (outside), below
    // it in Web Mercator's metres (inside), so a test in the literals' own numbers would answer TRUE.
    const triangle = { type: "Polygon", coordinates: [[[-100, 0], [0, 80], [0, 0], [-100, 0]]] };
    const pairs: [Literal, Literal][] = [[{ type: "Point", coordinates: [-50, 45] }, triangle]];
    for (let i = 0; i + 1 < LITERALS.length; i += 7) pairs.push([LITERALS[i]!, LITERALS[(i * 13 + 1) % LITERALS.length]!]);
    for (const [first, second] of pairs) {
      const [a, b] = [await inCrs(first, 3857, false), await inCrs(second, 3857, false)];
      if (!a || !b) continue;
      for (const op of ["s_intersects", "s_disjoint"]) {
        const { where, params } = toSql({ op, args: [a.given, b.given] } as unknown as Cql2Filter, { dialect: "postgres", columns, literals: { srid: 3857 } });
        const { rows } = await pool!.query(`SELECT COALESCE(${where}, FALSE) AS r`, [...params]);
        const ours = toPredicate({ op, args: [a.reference, b.reference] } as unknown as Cql2Filter, { spatialEngine: geosEngine })({});
        compared++;
        if (rows[0].r !== ours) differences.push(`${op} ${JSON.stringify(a.given).slice(0, 80)} ${JSON.stringify(b.given).slice(0, 80)}: sql ${rows[0].r}, evaluate ${ours}`);
      }
    }
    t.diagnostic(`${compared} pairs`);
    assert.equal(differences.slice(0, 10).join("\n"), "");
  });

  it("Part 3's Conformance Test 11: the collection's extent, converted to 3857, selects every state", async (t) => {
    if (skip) return t.skip(skip);
    const { rows: [extent] } = await pool!.query(
      `SELECT ST_XMin(e) AS w, ST_YMin(e) AS s, ST_XMax(e) AS e, ST_YMax(e) AS n FROM (SELECT ST_Extent(geom)::geometry AS e FROM cql2demo.states) x`,
    );
    const [[w, s], [e, n]] = (await convert([[extent.w, extent.s], [extent.e, extent.n]], 4326, 3857)) as [Pos, Pos];
    const box = { bbox: [w!, s!, e!, n!] };
    const { where, params } = toSql({ op: "s_intersects", args: [{ property: "geometry" }, box] } as unknown as Cql2Filter, {
      dialect: "postgres", columns, literals: { srid: 3857 },
    });
    const { rows } = await pool!.query(`SELECT count(*)::int AS n FROM cql2demo.states WHERE ${where}`, [...params]);
    assert.equal(rows[0].n, states.length);
  });

  it("a box across the antimeridian in 3857 (west above east) is refused, not turned round", () => {
    assert.throws(
      () => toSql({ op: "s_intersects", args: [{ property: "geometry" }, { bbox: [18924313, 6446275, -18924313, 8399737] }] } as unknown as Cql2Filter, {
        dialect: "postgres", columns, literals: { srid: 3857 },
      }),
      { code: "invalid-filter" },
    );
  });
});
