/**
 * S_INTERSECTS: ogc-cql2/evaluate on the states' GeoJSON against GEOS (through PostGIS) on the same states, for
 * thousands of generated literals, many placed exactly on the states' vertices and edges, where engines can disagree.
 * Both must select the same states. Runs against the database in `.env` with `cql2demo` loaded; skipped otherwise.
 *
 * The reference is GEOS's exact predicate, `NOT ST_Disjoint`. PostGIS's `ST_Intersects` takes a shortcut of its own
 * for a point in a polygon, which isn't exact for a point lying exactly on an edge: measured on PostGIS 3.5.6, it
 * says false where GEOS's DE-9IM matrix (`ST_Relate`), `ST_Disjoint` and `ST_Distance` = 0 all say the point is on the
 * boundary. The test counts those cases too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type { Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import pg from "pg";

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
  return out;
}
const LITERALS = generate();

/** The same literal for PostGIS: a box as an envelope, across the antimeridian two; else the GeoJSON geometry. */
function postgisCondition(literal: Literal): { sql: string; params: unknown[] } {
  if ("bbox" in literal) {
    const [w, s, e, n] = literal.bbox as number[];
    const env = (a: number, b: number) => `NOT ST_Disjoint(geom, ST_MakeEnvelope(${a}, ${s}, ${b}, ${n}, 4326))`;
    return { sql: w! > e! ? `(${env(w!, 180)} OR ${env(-180, e!)})` : env(w!, e!), params: [] };
  }
  return { sql: "NOT ST_Disjoint(geom, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))", params: [JSON.stringify(literal)] };
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

  it("PostGIS's ST_Intersects departs from GEOS only for points exactly on an edge (its point-in-polygon shortcut)", async (t) => {
    if (skip) return t.skip(skip);
    let departures = 0;
    for (const literal of LITERALS.filter((l) => l.type === "Point")) {
      const g = JSON.stringify(literal);
      const { rows } = await pool!.query(
        `SELECT count(*)::int AS n FROM cql2demo.states, (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) q
          WHERE ST_Intersects(geom, q.g) <> NOT ST_Disjoint(geom, q.g)`, [g]);
      if (rows[0].n === 0) continue;
      departures += rows[0].n;
      // Each departure: GEOS's matrix puts the point on the state's boundary (BI = 0).
      const { rows: m } = await pool!.query(
        `SELECT ST_Relate(geom, q.g) AS m FROM cql2demo.states, (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) q
          WHERE ST_Intersects(geom, q.g) <> NOT ST_Disjoint(geom, q.g)`, [g]);
      for (const { m: matrix } of m) assert.equal((matrix as string)[3], "0", `${g}: ${matrix}`);
    }
    t.diagnostic(`ST_Intersects departs from GEOS for ${departures} point-state pairs, each a point exactly on the state's boundary`);
  });
});
