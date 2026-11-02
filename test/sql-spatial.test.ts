/**
 * S_INTERSECTS in `toSql`'s `sqlite` dialect, and the SQL text of the `sqlite` and `duckdb` dialects. The differential
 * test runs every generated spatial filter on real tables and with `evaluate` on the same geometries as GeoJSON: both
 * must select exactly the same rows. SQLite (`node:sqlite`) holds the geometries as GeoPackage blobs with and without
 * the header's envelope, as plain WKB and as PostGIS's extended WKB (big-endian, SRID and Z flags); also empty
 * geometries, NULL, a text value and bytes that aren't a geometry, which are NULL as in `evaluate`. DuckDB's
 * differential test is in duckdb-spatial.ts, run once per DuckDB engine.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { sqliteFunctions, toSql, type SqlColumn } from "ogc-cql2/sql";
import {
  ALL, envelopeOf, FILTERS, GARBAGE, leaf, differences, fromEvaluate, literalFirst, LITERAL_PAIRS, pairDifferences, PAIR_FILTERS,
  pairsOf, RELATION_FILTERS, RELATIONS, STORAGES, stored, asGeoJson, type G,
} from "./spatial-cases.ts";

// --- SQLite ----------------------------------------------------------------------------------------------------------

const GEOMETRY: Record<string, SqlColumn> = { geometry: { format: "geometry-any", column: "geom" } };

describe("SQLite selects exactly what evaluate selects", () => {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);

  it.each(Object.keys(STORAGES))(`${FILTERS.length} spatial filters on ${ALL.length} geometries: %s`, (storage) => {
    db.exec(`DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER PRIMARY KEY, geom BLOB)`);
    const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
    ALL.forEach((v, i) => insert.run(i + 1, stored(v, STORAGES[storage]!) as never));
    const run = (filter: Cql2Filter) => {
      const { where, params } = toSql(filter, { dialect: "sqlite", columns: GEOMETRY });
      return (db.prepare(`SELECT id FROM t WHERE ${where} ORDER BY id`).all(...(params as never[])) as { id: number }[]).map((r) => r.id);
    };
    expect(differences(run, ALL.map(asGeoJson))).toBe("");
  });

  it(`with GeoPackage's R-tree, as its triggers fill it (no NULL, empty or unreadable geometries): ${FILTERS.length} filters`, () => {
    db.exec(`DROP TABLE IF EXISTS t; DROP TABLE IF EXISTS rtree_t_geom; CREATE TABLE t (id INTEGER PRIMARY KEY, geom BLOB);
             CREATE VIRTUAL TABLE rtree_t_geom USING rtree(id, minx, maxx, miny, maxy)`);
    const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
    const index = db.prepare("INSERT INTO rtree_t_geom VALUES (?, ?, ?, ?, ?)");
    ALL.forEach((v, i) => {
      insert.run(i + 1, stored(v, STORAGES["GeoPackage, envelope"]!) as never);
      const envelope = v === null || v === GARBAGE || (typeof v === "string" && v !== "empty") ? undefined : envelopeOf(v as G | "empty");
      if (envelope) index.run(i + 1, ...(envelope as never[]));
    });
    const columns = { geometry: { ...GEOMETRY.geometry!, rtree: "rtree_t_geom" } };
    const run = (filter: Cql2Filter) => {
      const { where, params } = toSql(filter, { dialect: "sqlite", columns });
      return (db.prepare(`SELECT id FROM t WHERE ${where} ORDER BY id`).all(...(params as never[])) as { id: number }[]).map((r) => r.id);
    };
    expect(differences(run, ALL.map(asGeoJson))).toBe("");
    // The R-tree is used: the plan names it.
    const { where, params } = toSql(leaf({ bbox: [0, 0, 2, 2] }) as unknown as Cql2Filter, { dialect: "sqlite", columns });
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM t WHERE ${where}`).all(...(params as never[])) as { detail: string }[];
    expect(plan.map((r) => r.detail).join("; ")).toMatch(/VIRTUAL TABLE INDEX/);
  });

  it("the test is not trivial: the filters select different, non-empty sets", () => {
    const results = new Set(FILTERS.map((f) => JSON.stringify(fromEvaluate(ALL.map(asGeoJson), f))));
    expect(results.size).toBeGreaterThan(20);
  });

  it("the relations' filters aren't trivial either: each relation selects something, in different sets", () => {
    for (const op of RELATIONS) {
      const results = RELATION_FILTERS.filter((f) => (f as { op: string }).op === op).map((f) => fromEvaluate(ALL.map(asGeoJson), f));
      expect(results.some((r) => r.length > 0), op).toBe(true);
      expect(new Set(results.map((r) => JSON.stringify(r))).size, op).toBeGreaterThan(1);
    }
  });
});

// --- Property-Property Comparisons: a literal first, two geometry columns, two literals ---------------------------

const PAIRS = pairsOf(ALL);
const PAIR_COLUMNS: Record<string, SqlColumn> = { ...GEOMETRY, other: { format: "geometry-any", column: "geom2" } };
/** S_INTERSECTS alone: Basic Spatial Functions, which SQLite evaluates without SpatiaLite (S_DISJOINT is Spatial Functions). */
const intersectsOnly = (filters: readonly Cql2Filter[]) => filters.filter((f) => /"op":"s_intersects"/.test(JSON.stringify(f)));

/** A table of every pair of the values, in a storage. */
function pairTable(db: DatabaseSync, storage: string): void {
  db.exec(`DROP TABLE IF EXISTS p; CREATE TABLE p (id INTEGER PRIMARY KEY, geom BLOB, geom2 BLOB)`);
  const insert = db.prepare("INSERT INTO p VALUES (?, ?, ?)");
  PAIRS.forEach(([a, b], i) => insert.run(i + 1, stored(a, STORAGES[storage]!) as never, stored(b, STORAGES[storage]!) as never));
}
const pairRun = (db: DatabaseSync, spatialite = false) => (filter: Cql2Filter) => {
  const { where, params } = toSql(filter, { dialect: "sqlite", columns: PAIR_COLUMNS, ...(spatialite ? { spatialite } : {}) });
  return (db.prepare(`SELECT id FROM p WHERE ${where} ORDER BY id`).all(...(params as never[])) as { id: number }[]).map((r) => r.id);
};
const asPairs = PAIRS.map(([a, b]): [unknown, unknown] => [asGeoJson(a), asGeoJson(b)]);

describe("Property-Property Comparisons in SQLite: exactly what evaluate selects", () => {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);

  it.each(Object.keys(STORAGES))(`the literal first: ${FILTERS.length} filters on ${ALL.length} geometries: %s`, (storage) => {
    db.exec(`DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER PRIMARY KEY, geom BLOB)`);
    const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
    ALL.forEach((v, i) => insert.run(i + 1, stored(v, STORAGES[storage]!) as never));
    const run = (filter: Cql2Filter) => {
      const { where, params } = toSql(filter, { dialect: "sqlite", columns: GEOMETRY });
      return (db.prepare(`SELECT id FROM t WHERE ${where} ORDER BY id`).all(...(params as never[])) as { id: number }[]).map((r) => r.id);
    };
    expect(differences(run, ALL.map(asGeoJson), FILTERS.map(literalFirst) as Cql2Filter[])).toBe("");
  });

  it.each(Object.keys(STORAGES))(`two geometry columns, S_INTERSECTS, ${PAIRS.length} pairs: %s`, (storage) => {
    pairTable(db, storage);
    expect(pairDifferences(pairRun(db), asPairs, intersectsOnly(PAIR_FILTERS))).toBe("");
  });

  it("two literals, S_INTERSECTS: decided without SQL", () => {
    for (const f of intersectsOnly(LITERAL_PAIRS)) expect(toSql(f, { dialect: "sqlite", columns: {} }).where).toMatch(/^[01]$/);
  });
});

// --- SQLite with SpatiaLite: the other relations ---------------------------------------------------------------------

/** mod_spatialite, from CQL2_SPATIALITE or the usual places; the reason it can't load, otherwise. */
function withSpatialite(): DatabaseSync | string {
  const tried: string[] = [];
  for (const path of [process.env.CQL2_SPATIALITE, "/opt/homebrew/lib/mod_spatialite", "/usr/local/lib/mod_spatialite", "/usr/lib/x86_64-linux-gnu/mod_spatialite", "mod_spatialite"]) {
    if (!path) continue;
    try {
      const db = new DatabaseSync(":memory:", { allowExtension: true });
      db.loadExtension(path);
      return db;
    } catch (error) {
      tried.push(`${path}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  return `SpatiaLite (mod_spatialite) can't load; set CQL2_SPATIALITE to its path. Tried ${tried.join("; ")}`;
}

describe("SQLite with SpatiaLite: the other relations, exactly as evaluate (with GEOS) selects", () => {
  const db = withSpatialite();
  const skip = typeof db === "string" ? db : "";
  if (typeof db !== "string") for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);
  const run = (columns: Record<string, SqlColumn>) => (filter: Cql2Filter) => {
    const { where, params } = toSql(filter, { dialect: "sqlite", columns, spatialite: true });
    return ((db as DatabaseSync).prepare(`SELECT id FROM t WHERE ${where} ORDER BY id`).all(...(params as never[])) as { id: number }[]).map((r) => r.id);
  };

  it.for(Object.keys(STORAGES))(`${RELATION_FILTERS.length} filters on ${ALL.length} values: %s`, (storage, context) => {
    if (skip) return context.skip(skip);
    const d = db as DatabaseSync;
    d.exec(`DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER PRIMARY KEY, geom BLOB)`);
    const insert = d.prepare("INSERT INTO t VALUES (?, ?)");
    ALL.forEach((v, i) => insert.run(i + 1, stored(v, STORAGES[storage]!) as never));
    expect(differences(run(GEOMETRY), ALL.map(asGeoJson), RELATION_FILTERS)).toBe("");
  });

  it.for(Object.keys(STORAGES))(`the literal first: ${RELATION_FILTERS.length} filters: %s`, (storage, context) => {
    if (skip) return context.skip(skip);
    const d = db as DatabaseSync;
    d.exec(`DROP TABLE IF EXISTS t; CREATE TABLE t (id INTEGER PRIMARY KEY, geom BLOB)`);
    const insert = d.prepare("INSERT INTO t VALUES (?, ?)");
    ALL.forEach((v, i) => insert.run(i + 1, stored(v, STORAGES[storage]!) as never));
    expect(differences(run(GEOMETRY), ALL.map(asGeoJson), RELATION_FILTERS.map(literalFirst) as Cql2Filter[])).toBe("");
  });

  it.for(Object.keys(STORAGES))(`two geometry columns, every relation, ${PAIRS.length} pairs: %s`, (storage, context) => {
    if (skip) return context.skip(skip);
    pairTable(db as DatabaseSync, storage);
    expect(pairDifferences(pairRun(db as DatabaseSync, true), asPairs, PAIR_FILTERS)).toBe("");
  });

  it(`two literals, every relation: ${LITERAL_PAIRS.length} filters`, (context) => {
    if (skip) return context.skip(skip);
    pairTable(db as DatabaseSync, "WKB");
    expect(pairDifferences(pairRun(db as DatabaseSync, true), asPairs, LITERAL_PAIRS)).toBe("");
  });

  it(`with GeoPackage's R-tree: ${RELATION_FILTERS.length} filters`, (context) => {
    if (skip) return context.skip(skip);
    const d = db as DatabaseSync;
    d.exec(`DROP TABLE IF EXISTS t; DROP TABLE IF EXISTS rtree_t_geom; CREATE TABLE t (id INTEGER PRIMARY KEY, geom BLOB);
            CREATE VIRTUAL TABLE rtree_t_geom USING rtree(id, minx, maxx, miny, maxy)`);
    const insert = d.prepare("INSERT INTO t VALUES (?, ?)");
    const index = d.prepare("INSERT INTO rtree_t_geom VALUES (?, ?, ?, ?, ?)");
    ALL.forEach((v, i) => {
      insert.run(i + 1, stored(v, STORAGES["GeoPackage, envelope"]!) as never);
      const envelope = v === null || v === GARBAGE || (typeof v === "string" && v !== "empty") ? undefined : envelopeOf(v as G | "empty");
      if (envelope) index.run(i + 1, ...(envelope as never[]));
    });
    expect(differences(run({ geometry: { ...GEOMETRY.geometry!, rtree: "rtree_t_geom" } }), ALL.map(asGeoJson), RELATION_FILTERS)).toBe("");
  });
});

// --- The SQL text ----------------------------------------------------------------------------------------------------

describe("the SQL it builds", () => {
  const leafOf = (op: string, literal: unknown) => ({ op, args: [{ property: "geometry" }, literal] });
  const s = (literal: unknown, dialect: "sqlite" | "duckdb", column: SqlColumn) =>
    toSql(leaf(literal) as unknown as Cql2Filter, { dialect, columns: { geometry: column } });

  it("sqlite: cql2_intersects on the column, the literal as JSON text", () => {
    expect(s({ bbox: [0, 40, 10, 50] }, "sqlite", { format: "geometry-polygon", column: "geom" })).toEqual({
      where: `cql2_intersects("geom", ?) = 1`,
      params: ['{"bbox":[0,40,10,50]}'],
    });
  });

  it("duckdb, GEOMETRY: ST_Intersects(column, literal), as DuckDB documents it; across the antimeridian one literal, the union of the halves", () => {
    const env = (n: number) => `ST_MakeEnvelope($${n}::DOUBLE, $${n + 1}::DOUBLE, $${n + 2}::DOUBLE, $${n + 3}::DOUBLE)`;
    expect(s({ bbox: [0, 40, 10, 50] }, "duckdb", { sqlType: "GEOMETRY", column: "geom" })).toEqual({
      where: `ST_Intersects("geom", ${env(1)})`,
      params: ["0", "40", "10", "50"],
    });
    expect(s({ bbox: [170, -10, -170, 10] }, "duckdb", { sqlType: "GEOMETRY", column: "geom" })).toEqual({
      where: `ST_Intersects("geom", ST_Union(${env(1)}, ${env(5)}))`,
      params: ["170", "-10", "180", "10", "-180", "-10", "-170", "10"],
    });
    expect(s({ type: "Point", coordinates: [1, 2] }, "duckdb", { format: "geometry-point", column: "geom" })).toEqual({
      where: `ST_Intersects("geom", ST_GeomFromGeoJSON($1))`,
      params: ['{"type":"Point","coordinates":[1,2]}'],
    });
  });

  it("duckdb, BLOB: the WKB read with TRY(ST_GeomFromWKB(…)), so bytes that aren't WKB are NULL", () => {
    expect(s({ type: "Point", coordinates: [1, 2] }, "duckdb", { sqlType: "BLOB", column: "geom" }).where).toBe(
      `ST_Intersects(TRY(ST_GeomFromWKB("geom")), ST_GeomFromGeoJSON($1))`,
    );
  });

  it("duckdb with GeoParquet's covering: its four fields compared first, the box rounded outward to 32-bit floats; under a NOT the exact test alone", () => {
    const covering = { bbox: { xmin: ["bbox", "xmin"], ymin: ["bbox", "ymin"], xmax: ["bbox", "xmax"], ymax: ["bbox", "ymax"] } } as const;
    const column = { sqlType: "GEOMETRY", column: "geom", covering } as const;
    const overlap = (n: number) => `"bbox"."xmin" <= $${n}::DOUBLE AND "bbox"."xmax" >= $${n + 1}::DOUBLE AND "bbox"."ymin" <= $${n + 2}::DOUBLE AND "bbox"."ymax" >= $${n + 3}::DOUBLE`;
    expect(s({ bbox: [0, 40, 10, 50] }, "duckdb", column)).toEqual({
      where: `((${overlap(5)}) AND ST_Intersects("geom", ST_MakeEnvelope($1::DOUBLE, $2::DOUBLE, $3::DOUBLE, $4::DOUBLE)))`,
      params: ["0", "40", "10", "50", "10", "0", "50", "40"],
    });
    // 0.1 and 0.7 aren't 32-bit floats: the west and south edges go down to the next one, so a FLOAT field still matches.
    expect(s({ bbox: [0.1, 0.7, 1, 1] }, "duckdb", column).params.slice(4)).toEqual(["1", "0.09999999403953552", "1", "0.699999988079071"]);
    expect(Math.fround(0.09999999403953552)).toBe(0.09999999403953552);
    expect(s({ bbox: [170, -10, -170, 10] }, "duckdb", column).where).toMatch(/^\(\(\(.+\) OR \(.+\)\) AND ST_Intersects\("geom", ST_Union\(/);
    expect(s({ type: "LineString", coordinates: [[1, 2], [3, -4]] }, "duckdb", column).params.slice(1)).toEqual(["3", "1", "2", "-4"]);
    expect(s({ type: "Point", coordinates: [1, 2] }, "duckdb", { ...column, sqlType: "BLOB" }).where).toBe(
      `((${overlap(2)}) AND ST_Intersects(TRY(ST_GeomFromWKB("geom")), ST_GeomFromGeoJSON($1)))`,
    );
    const negated = toSql({ op: "not", args: [leaf({ bbox: [0, 40, 10, 50] })] } as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: column } });
    expect(negated.where).toBe(`NOT (ST_Intersects("geom", ST_MakeEnvelope($1::DOUBLE, $2::DOUBLE, $3::DOUBLE, $4::DOUBLE)))`);
    const twice = toSql({ op: "not", args: [{ op: "not", args: [leaf({ bbox: [0, 40, 10, 50] })] }] } as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: column } });
    expect(twice.where).toContain(`"bbox"."xmin"`);
    const broken = { ...column, covering: { bbox: { ...covering.bbox, ymax: "bbox.ymax" } } } as unknown as SqlColumn;
    expect(() => s({ bbox: [0, 40, 10, 50] }, "duckdb", broken)).toThrow(/covering\.bbox\.ymax must be the path of a field/);
  });

  it("sqlite with the R-tree: the candidates from it, then the exact test; under a NOT the exact test alone", () => {
    const column = { format: "geometry-polygon", column: "geom", rtree: "rtree_t_geom" } as const;
    expect(s({ bbox: [0, 40, 10, 50] }, "sqlite", column)).toEqual({
      where: `(rowid IN (SELECT id FROM "rtree_t_geom" WHERE (minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?)) AND cql2_intersects("geom", ?) = 1)`,
      params: [10, 0, 50, 40, '{"bbox":[0,40,10,50]}'],
    });
    expect(s({ bbox: [170, -10, -170, 10] }, "sqlite", column).where).toContain(
      `WHERE (minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?) OR (minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?))`,
    );
    expect(s({ bbox: [170, -10, -170, 10] }, "sqlite", column).params.slice(0, 8)).toEqual([180, 170, 10, -10, -170, -180, 10, -10]);
    expect(s({ type: "LineString", coordinates: [[1, 2], [3, -4]] }, "sqlite", column).params.slice(0, 4)).toEqual([3, 1, 2, -4]);
    const negated = toSql({ op: "not", args: [leaf({ bbox: [0, 40, 10, 50] })] } as unknown as Cql2Filter, { dialect: "sqlite", columns: { geometry: column } });
    expect(negated.where).toBe(`NOT (cql2_intersects("geom", ?) = 1)`);
    const twice = toSql({ op: "not", args: [{ op: "not", args: [leaf({ bbox: [0, 40, 10, 50] })] }] } as unknown as Cql2Filter, { dialect: "sqlite", columns: { geometry: column } });
    expect(twice.where).toContain("rowid IN");
  });

  it("a column that holds no geometry: nothing matches", () => {
    expect(s({ bbox: [0, 0, 1, 1] }, "sqlite", { type: "string" })).toEqual({ where: "NULL", params: [] });
    expect(s({ bbox: [0, 0, 1, 1] }, "duckdb", { sqlType: "VARCHAR" })).toEqual({ where: "NULL::BOOLEAN", params: [] });
  });

  it("sqlite: the other relations need SpatiaLite (spatialite: true); without it they are unsupported", () => {
    expect(() => toSql({ op: "s_within", args: [{ property: "geometry" }, { bbox: [0, 0, 1, 1] }] } as unknown as Cql2Filter, { dialect: "sqlite", columns: GEOMETRY }))
      .toThrow(expect.objectContaining({ code: "unsupported", details: { conformance: "http://www.opengis.net/spec/cql2/1.0/conf/spatial-functions" } }));
  });

  it("sqlite with SpatiaLite: SpatiaLite's GeoPackage reader first, cql2_wkt where it can't read; the literal as WKT, once per placeholder", () => {
    const fn = (g: string) => `ST_Within(${g}, GeomFromText(?, 4326))`;
    const form = `COALESCE(NULLIF(${fn(`GeomFromGPB("geom")`)}, -1), CASE length(cql2_wkt("geom")) WHEN 0 THEN 0 ELSE NULLIF(${fn(`GeomFromText(cql2_wkt("geom"), 4326)`)}, -1) END)`;
    const r = (filter: unknown, column: SqlColumn = GEOMETRY.geometry!) => toSql(filter as Cql2Filter, { dialect: "sqlite", columns: { geometry: column }, spatialite: true });
    const box = "POLYGON((0 40, 10 40, 10 50, 0 50, 0 40))";
    expect(r(leafOf("s_within", { bbox: [0, 40, 10, 50] }))).toEqual({ where: form, params: [box, box] });
    // Across the antimeridian a multipolygon; with the R-tree its candidates first, their parameters first.
    expect(r(leafOf("s_within", { bbox: [170, -10, -170, 10] })).params[0]).toBe("MULTIPOLYGON(((170 -10, 180 -10, 180 10, 170 10, 170 -10)), ((-180 -10, -170 -10, -170 10, -180 10, -180 -10)))");
    const indexed = { ...GEOMETRY.geometry!, rtree: "rtree_t_geom" };
    expect(r(leafOf("s_within", { bbox: [0, 40, 10, 50] }), indexed)).toEqual({
      where: `(rowid IN (SELECT id FROM "rtree_t_geom" WHERE (minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?)) AND ${form})`,
      params: [10, 0, 50, 40, box, box],
    });
    expect(r({ op: "not", args: [leafOf("s_within", { bbox: [0, 40, 10, 50] })] }, indexed).where).toBe(`NOT (${form})`);
    expect(r(leafOf("s_disjoint", { bbox: [0, 40, 10, 50] })).where).toBe(`NOT (cql2_intersects("geom", ?) = 1)`);
  });

  it("duckdb, the other relations: ST_<relation>(column, literal), with the covering's comparisons first outside a NOT; S_DISJOINT as NOT S_INTERSECTS", () => {
    const column = { sqlType: "GEOMETRY", column: "geom" } as const;
    const covered = { ...column, covering: { bbox: { xmin: ["bbox", "xmin"], ymin: ["bbox", "ymin"], xmax: ["bbox", "xmax"], ymax: ["bbox", "ymax"] } } } as const;
    const r = (op: string, literal: unknown, c: SqlColumn = column) => toSql({ op, args: [{ property: "geometry" }, literal] } as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: c } });
    const point = { type: "Point", coordinates: [1, 2] };
    for (const [op, fn] of [["s_equals", "ST_Equals"], ["s_touches", "ST_Touches"], ["s_within", "ST_Within"], ["s_overlaps", "ST_Overlaps"], ["s_crosses", "ST_Crosses"], ["s_contains", "ST_Contains"]]) {
      expect(r(op!, point).where).toBe(`${fn}("geom", ST_GeomFromGeoJSON($1))`);
      expect(r(op!, point, { sqlType: "BLOB", column: "geom" }).where).toBe(`${fn}(TRY(ST_GeomFromWKB("geom")), ST_GeomFromGeoJSON($1))`);
      expect(r(op!, point, covered).where).toMatch(new RegExp(`^\\(\\("bbox"\\."xmin" <= .+\\) AND ${fn}\\("geom", ST_GeomFromGeoJSON\\(\\$1\\)\\)\\)$`));
    }
    expect(r("s_within", { bbox: [170, -10, -170, 10] }).where).toMatch(/^ST_Within\("geom", ST_Union\(ST_MakeEnvelope\(/);
    expect(r("s_disjoint", point).where).toBe(`NOT (ST_Intersects("geom", ST_GeomFromGeoJSON($1)))`);
    expect(r("s_disjoint", point, covered).where).toBe(`NOT (ST_Intersects("geom", ST_GeomFromGeoJSON($1)))`); // under a NOT: no covering
    const negated = toSql({ op: "not", args: [{ op: "s_within", args: [{ property: "geometry" }, point] }] } as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: covered } });
    expect(negated.where).toBe(`NOT (ST_Within("geom", ST_GeomFromGeoJSON($1)))`);
    expect(r("s_within", point, { sqlType: "VARCHAR" }).where).toBe("NULL::BOOLEAN");
  });
});
