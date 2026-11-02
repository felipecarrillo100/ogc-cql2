/**
 * S_INTERSECTS in `toSql`'s `duckdb` dialect, run once per DuckDB engine, each in a test file (so a process) of its
 * own: a process loads one DuckDB native library, whichever it loads first.
 * - DuckDB 2.0 (`@duckdb/node-api`), as in Node;
 * - DuckDB 1.4.3 (`@duckdb/node-api-1.4`), the engine of DuckDB-WASM 1.32.0, as in the browser.
 *
 * The differential test runs every spatial filter of spatial-cases.ts on a `GEOMETRY` and a `BLOB` (WKB) column, each
 * without and with GeoParquet's bbox covering (`DOUBLE` and `FLOAT` fields), against `evaluate` on the same values.
 * The canaries state what the dialect relies on in DuckDB; each fails when a DuckDB release changes it, and says what
 * to update (docs/architecture.md, "DuckDB: what we rely on"). And the standard's Table 16 (Property-Property
 * Comparisons) on its test data, in each engine.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { fromText } from "ogc-cql2/parse";
import { toSql, type SqlColumn } from "ogc-cql2/sql";
import { PLACES_QUERYABLES, places, sqlLiteral, TABLE_16, TABLE_17 } from "./table16.ts";
import {
  ALL, asGeoJson, differences, FILTERS, leaf, LITERAL_FIRST, LITERAL_PAIRS, pairDifferences, PAIR_FILTERS, pairsOf, RELATION_FILTERS,
  RELATIONS, STORAGES, stored, VALUES, wkb, type G,
} from "./spatial-cases.ts";

/** What the tests use of `@duckdb/node-api`, the same in both versions. */
interface Connection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string, params?: never): Promise<{ getRows(): unknown[][] }>;
  closeSync(): void;
}
export interface Engine {
  readonly DuckDBInstance: { create(path: string): Promise<{ connect(): Promise<Connection> }> };
}

const COVERING = { bbox: { xmin: ["bbox", "xmin"], ymin: ["bbox", "ymin"], xmax: ["bbox", "xmax"], ymax: ["bbox", "ymax"] } } as const;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/**
 * The covering's struct of a geometry, NULL when there is none (GeoParquet: a bbox if and only if a geometry). With
 * `raw`, the stored value: one that isn't a geometry but isn't NULL gets a box far from every literal, as a corrupt
 * file could hold, for which `evaluate` gives NULL and the box test FALSE: under a NOT the box test would select it.
 */
const bboxOf = (g: string, type: "DOUBLE" | "FLOAT", raw?: string) =>
  `CASE ${raw ? `WHEN ${raw} IS NOT NULL AND ${g} IS NULL THEN {'xmin': 100, 'ymin': 50, 'xmax': 101, 'ymax': 51}::STRUCT(xmin ${type}, ymin ${type}, xmax ${type}, ymax ${type}) ` : ""}` +
  `WHEN ${g} IS NULL OR ST_IsEmpty(${g}) THEN NULL ELSE {'xmin': ST_XMin(${g})::${type}, 'ymin': ST_YMin(${g})::${type}, 'xmax': ST_XMax(${g})::${type}, 'ymax': ST_YMax(${g})::${type}} END`;

/**
 * Which engine the suite runs on: the exact `SELECT version()` (without the `v`), and its line, which picks the
 * canaries' expectations. `"1.4"`: the spatial extension's own GEOMETRY type, as in 1.4.x; `"core"`: GEOMETRY in
 * DuckDB's core (from 1.5), with statistics per row group. A new release is held to its line's behaviour, so what
 * changed shows as a failure (scripts/check-duckdb.mjs).
 */
export interface EngineProfile {
  readonly version: string;
  readonly line: "1.4" | "core";
}

export function duckdbSpatialSuite(name: string, { version, line }: EngineProfile, engine: Engine): void {
  let duck: Connection;
  let spatial = "";
  const dir = mkdtempSync(join(tmpdir(), "ogc-cql2-duckdb-"));
  beforeAll(async () => {
    duck = await (await engine.DuckDBInstance.create(":memory:")).connect();
    try {
      await duck.run("INSTALL spatial");
      await duck.run("LOAD spatial");
    } catch (error) {
      spatial = `DuckDB's spatial extension can't load: ${(error as Error).message}`;
    }
  }, 120_000); // INSTALL downloads the extension on a fresh machine (CI, a new clone), beside the other test files
  afterAll(() => {
    duck?.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = async (sql: string, params: readonly unknown[] = []) => (await duck.runAndReadAll(sql, params as never)).getRows();
  async function select(table: string, column: SqlColumn, filter: Cql2Filter): Promise<number[]> {
    const { where, params } = toSql(filter, { dialect: "duckdb", columns: { geometry: column } });
    return (await rows(`SELECT id FROM ${table} WHERE ${where} ORDER BY id`, params)).map((r) => r[0] as number);
  }
  /** Each filter's rows, in order: `differences` asks for them synchronously. */
  async function all(table: string, column: SqlColumn, filters: readonly Cql2Filter[] = FILTERS): Promise<(filter: Cql2Filter) => number[]> {
    const results = new Map<string, number[]>();
    for (const filter of filters) results.set(JSON.stringify(filter), await select(table, column, filter));
    return (filter) => results.get(JSON.stringify(filter))!;
  }

  describe(`${name}: selects exactly what evaluate selects`, () => {
    it(`is DuckDB ${version}`, async (context) => {
      if (spatial) return context.skip(spatial);
      expect(String((await rows("SELECT version()"))[0]![0])).toBe(`v${version}`);
    });

    // In a BLOB column the text is bytes too, which aren't WKB: NULL, as `evaluate` gives for a string.
    const blobs = async () => {
      await duck.run("CREATE OR REPLACE TABLE w (id INTEGER, geom BLOB)");
      for (const [i, v] of ALL.entries()) {
        const value = stored(v, STORAGES.WKB!);
        const bytes = value === null ? null : typeof value === "string" ? new TextEncoder().encode(value) : (value as Uint8Array);
        await duck.run(`INSERT INTO w VALUES (${i + 1}, ${bytes === null ? "NULL" : `from_hex('${hex(bytes)}')`})`);
      }
      const g = "TRY(ST_GeomFromWKB(geom))";
      await duck.run(`CREATE OR REPLACE TABLE w2 AS SELECT *, ${bboxOf(g, "DOUBLE", "geom")} AS bbox FROM w; CREATE OR REPLACE TABLE w4 AS SELECT *, ${bboxOf(g, "FLOAT", "geom")} AS bbox FROM w`);
    };
    const geometries = VALUES.filter((v) => v !== "empty" && typeof v !== "string") as (G | null)[];
    const GEOMETRIES = [...geometries, "empty" as const];
    const geometryTables = async () => {
      await duck.run("CREATE OR REPLACE TABLE g (id INTEGER, geom GEOMETRY)");
      for (const [i, v] of GEOMETRIES.entries()) {
        await duck.run(`INSERT INTO g VALUES (${i + 1}, ${v === null ? "NULL" : `ST_GeomFromWKB(from_hex('${hex(wkb(v))}'))`})`);
      }
      await duck.run(`CREATE OR REPLACE TABLE g2 AS SELECT *, ${bboxOf("geom", "DOUBLE")} AS bbox FROM g; CREATE OR REPLACE TABLE g4 AS SELECT *, ${bboxOf("geom", "FLOAT")} AS bbox FROM g`);
    };

    it.for([
      ["w", "no covering"],
      ["w2", "covering of DOUBLE fields"],
      ["w4", "covering of FLOAT fields"],
    ] as const)(`a BLOB column of WKB, %s: ${FILTERS.length} filters`, async ([table, label], context) => {
      if (spatial) return context.skip(spatial);
      await blobs();
      const column: SqlColumn = { sqlType: "BLOB", column: "geom", ...(label === "no covering" ? {} : { covering: COVERING }) };
      expect(differences(await all(table, column), ALL.map(asGeoJson))).toBe("");
    });

    it.for([
      ["g", "no covering"],
      ["g2", "covering of DOUBLE fields"],
      ["g4", "covering of FLOAT fields"],
    ] as const)(`a GEOMETRY column, %s: ${FILTERS.length} filters`, async ([table, label], context) => {
      if (spatial) return context.skip(spatial);
      await geometryTables();
      const column: SqlColumn = { sqlType: "GEOMETRY", column: "geom", ...(label === "no covering" ? {} : { covering: COVERING }) };
      expect(differences(await all(table, column), GEOMETRIES.map(asGeoJson))).toBe("");
    });

    it.for([
      ["w", "BLOB", "no covering"],
      ["w2", "BLOB", "covering of DOUBLE fields"],
      ["w4", "BLOB", "covering of FLOAT fields"],
      ["g", "GEOMETRY", "no covering"],
      ["g2", "GEOMETRY", "covering of DOUBLE fields"],
      ["g4", "GEOMETRY", "covering of FLOAT fields"],
    ] as const)(`the other relations, %s: ${RELATION_FILTERS.length} filters against evaluate with GEOS`, async ([table, type, label], context) => {
      if (spatial) return context.skip(spatial);
      if (type === "BLOB") await blobs();
      else await geometryTables();
      const column: SqlColumn = { sqlType: type, column: "geom", ...(label === "no covering" ? {} : { covering: COVERING }) };
      const values = type === "BLOB" ? ALL.map(asGeoJson) : GEOMETRIES.map(asGeoJson);
      expect(differences(await all(table, column, RELATION_FILTERS), values, RELATION_FILTERS)).toBe("");
    });

    // Property-Property Comparisons: a literal first, two geometry columns, two literals.
    it.for([["w", "BLOB"], ["g", "GEOMETRY"]] as const)(`the literal first, %s (%s): ${LITERAL_FIRST.length} filters`, async ([table, type], context) => {
      if (spatial) return context.skip(spatial);
      if (type === "BLOB") await blobs();
      else await geometryTables();
      const values = type === "BLOB" ? ALL.map(asGeoJson) : GEOMETRIES.map(asGeoJson);
      expect(differences(await all(table, { sqlType: type, column: "geom" }, LITERAL_FIRST), values, LITERAL_FIRST)).toBe("");
    });

    it.for(["BLOB", "GEOMETRY"] as const)(`two geometry columns (%s), every relation, and two literals`, { timeout: 120_000 }, async (type, context) => {
      if (spatial) return context.skip(spatial);
      const values = type === "BLOB" ? ALL : GEOMETRIES;
      const pairs = pairsOf<unknown>(values);
      await duck.run(`CREATE OR REPLACE TABLE pr (id INTEGER, geom ${type}, geom2 ${type})`);
      const sqlOf = (v: unknown) => {
        if (v === null) return "NULL";
        if (type === "GEOMETRY") return `ST_GeomFromWKB(from_hex('${hex(wkb(v as G | "empty"))}'))`;
        const value = stored(v as never, STORAGES.WKB!);
        return `from_hex('${hex(typeof value === "string" ? new TextEncoder().encode(value) : (value as Uint8Array))}')`;
      };
      for (const [i, [a, b]] of pairs.entries()) await duck.run(`INSERT INTO pr VALUES (${i + 1}, ${sqlOf(a)}, ${sqlOf(b)})`);
      const columns = { geometry: { sqlType: type, column: "geom" }, other: { sqlType: type, column: "geom2" } };
      const results = new Map<string, number[]>();
      for (const filter of [...PAIR_FILTERS, ...LITERAL_PAIRS]) {
        const { where, params } = toSql(filter, { dialect: "duckdb", columns });
        results.set(JSON.stringify(filter), (await rows(`SELECT id FROM pr WHERE ${where} ORDER BY id`, params)).map((r) => r[0] as number));
      }
      const run = (filter: Cql2Filter) => results.get(JSON.stringify(filter))!;
      const asPairs = pairs.map(([a, b]): [unknown, unknown] => [asGeoJson(a as never), asGeoJson(b as never)]);
      expect(pairDifferences(run, asPairs, [...PAIR_FILTERS, ...LITERAL_PAIRS])).toBe("");
    });

    it("the R-tree index is used for every relation but S_DISJOINT", async (context) => {
      if (spatial) return context.skip(spatial);
      await duck.run("SELECT setseed(0.1)");
      await duck.run("CREATE OR REPLACE TABLE ix AS SELECT ST_Point(random() * 360 - 180, random() * 180 - 90) AS geom FROM range(200000); CREATE INDEX ix_geom ON ix USING RTREE (geom)");
      for (const op of RELATIONS.filter((r) => r !== "s_disjoint")) {
        const { where, params } = toSql({ op, args: [{ property: "geometry" }, { bbox: [10, 10, 15, 15] }] } as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: { sqlType: "GEOMETRY", column: "geom" } } });
        const plan = (await rows(`EXPLAIN SELECT count(*) FROM ix WHERE ${where}`, params)).map((r) => r[1]).join("\n");
        expect(plan, op).toMatch(/rtree[ _]index[ _]scan/i);
      }
    });

    it("the R-tree index is used: for a box, a geometry as a parameter, and a box across the antimeridian", async (context) => {
      if (spatial) return context.skip(spatial);
      await duck.run("SELECT setseed(0.1)");
      await duck.run("CREATE OR REPLACE TABLE ix AS SELECT ST_Point(random() * 360 - 180, random() * 180 - 90) AS geom FROM range(200000); CREATE INDEX ix_geom ON ix USING RTREE (geom)");
      for (const literal of [{ bbox: [10, 10, 15, 15] }, { type: "Polygon", coordinates: [[[10, 10], [15, 10], [15, 15], [10, 10]]] }, { bbox: [170, 10, -170, 15] }]) {
        const { where, params } = toSql(leaf(literal) as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: { sqlType: "GEOMETRY", column: "geom" } } });
        const plan = (await rows(`EXPLAIN SELECT count(*) FROM ix WHERE ${where}`, params)).map((r) => r[1]).join("\n");
        expect(plan, JSON.stringify(literal)).toMatch(/rtree[ _]index[ _]scan/i);
      }
    });
  });

  describe(`${name}: what the dialect relies on (canaries)`, () => {
    it("plain ST_GeomFromWKB still fails the whole query on bytes that aren't WKB: the dialect needs TRY(…)", async (context) => {
      if (spatial) return context.skip(spatial);
      await duck.run("CREATE OR REPLACE TABLE bad AS SELECT * FROM (VALUES (from_hex('0102030405'))) t(geom)");
      await expect(rows("SELECT count(*) FROM bad WHERE ST_Intersects(ST_GeomFromWKB(geom), ST_MakeEnvelope(0, 0, 1, 1))"), "DuckDB now reads bad WKB without failing: TRY may be dropped (duckdbIntersects)")
        .rejects.toThrow();
    });

    // DuckDB 2.0's bug alone: 1.4 and 1.5 (DuckDB-WASM's engines) run the query, exactly and with the index.
    const coveringFails = Number(version.split(".")[0]) >= 2;
    it(coveringFails
      ? "a covering on a table with an R-tree index still fails (DuckDB 2.0's bug): keep the limitation documented"
      : "a covering on a table with an R-tree index works", async (context) => {
      if (spatial) return context.skip(spatial);
      await duck.run("CREATE OR REPLACE TABLE ixc AS SELECT ST_Point(x, x) AS geom, {'xmin': x::DOUBLE, 'ymin': x::DOUBLE, 'xmax': x::DOUBLE, 'ymax': x::DOUBLE} AS bbox FROM range(0, 5000) t(x); CREATE INDEX ixc_geom ON ixc USING RTREE (geom)");
      const { where, params } = toSql(leaf({ bbox: [10, 10, 20, 20] }) as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: { sqlType: "GEOMETRY", column: "geom", covering: COVERING } } });
      const run = rows(`SELECT count(*) FROM ixc WHERE ${where}`, params);
      if (coveringFails) {
        await expect(run, "DuckDB now filters on a covering on an indexed table: lift the limitation (SqlColumn.covering, README, docs/architecture.md)")
          .rejects.toThrow(/Failed to bind column reference/);
      } else {
        expect(Number((await run)[0]![0])).toBe(11);
      }
    });

    it.runIf(line === "core")("DuckDB still doesn't use a GeoParquet 1.1 covering by itself: the dialect writes its comparisons", async (context) => {
      if (spatial) return context.skip(spatial);
      const file = join(dir, "covering.parquet");
      const geo = JSON.stringify({ version: "1.1.0", primary_column: "geom", columns: { geom: { encoding: "WKB", geometry_types: [], covering: COVERING } } });
      await duck.run(`COPY (SELECT ST_AsWKB(ST_Point(x / 200, x / 400))::BLOB AS geom, {'xmin': x / 200, 'ymin': x / 400, 'xmax': x / 200, 'ymax': x / 400} AS bbox FROM range(0, 20480) t(x))
        TO '${file}' (FORMAT parquet, ROW_GROUP_SIZE 2048, GEOPARQUET_VERSION 'NONE', KV_METADATA {geo: '${geo}'})`);
      const scanned = async (column: SqlColumn) => {
        const { where, params } = toSql(leaf({ bbox: [50, 25, 52, 26] }) as unknown as Cql2Filter, { dialect: "duckdb", columns: { geometry: column } });
        const profile = JSON.parse(String((await rows(`EXPLAIN (ANALYZE, FORMAT json) SELECT count(*) FROM '${file}' WHERE ${where}`, params))[0]![1]));
        let found: [number, number] | undefined;
        const walk = (n: { row_groups_scanned?: number; total_row_groups_to_scan?: number; children?: unknown[]; operator?: unknown[] }) => {
          if (n.total_row_groups_to_scan !== undefined) found ??= [n.row_groups_scanned!, n.total_row_groups_to_scan];
          (n.children ?? n.operator ?? []).forEach((c) => walk(c as never));
        };
        walk(profile);
        return found;
      };
      const counted = await scanned({ sqlType: "GEOMETRY", column: "geom" });
      if (!counted) return context.skip("this DuckDB's profile doesn't count the row groups scanned: can't tell");
      const [plain, groups] = counted;
      expect(plain, "DuckDB now skips row groups from a covering by itself: the covering's comparisons may become unnecessary (SqlColumn.covering, docs)").toBe(groups);
      const [covered] = (await scanned({ sqlType: "GEOMETRY", column: "geom", covering: COVERING }))!;
      expect(covered).toBeLessThan(groups);
    });

    // A measurement, not a gate: timings move with the machine's load (other test files run in parallel), so it only
    // reports the ratio, and fails on it only when asked to (CQL2_CANARY_TIMING=1, e.g. after a DuckDB upgrade).
    it.runIf(line === "core")("ST_Intersects alone without an index, against ST_Intersects with ST_Intersects_Extent: the evidence an engine option would need", async (context) => {
      if (spatial) return context.skip(spatial);
      await duck.run("SELECT setseed(0.1)");
      await duck.run("CREATE OR REPLACE TABLE noidx AS SELECT ST_Point(random() * 360 - 180, random() * 180 - 90) AS geom FROM range(200000)");
      const best = async (sql: string) => {
        await rows(sql);
        let ms = Infinity;
        for (let i = 0; i < 3; i++) {
          const t = performance.now();
          await rows(sql);
          ms = Math.min(ms, performance.now() - t);
        }
        return ms;
      };
      const L = "ST_MakeEnvelope(10, 10, 15, 15)";
      const plain = await best(`SELECT count(*) FROM noidx WHERE ST_Intersects(geom, ${L})`);
      const paired = await best(`SELECT count(*) FROM noidx WHERE ST_Intersects(geom, ${L}) AND ST_Intersects_Extent(geom, ${L})`);
      context.annotate(`ST_Intersects alone ${plain.toFixed(1)} ms, with ST_Intersects_Extent ${paired.toFixed(1)} ms (${(plain / paired).toFixed(1)}×)`);
      if (process.env.CQL2_CANARY_TIMING === "1") {
        expect(plain / paired, "The gap closed: plain ST_Intersects is now as fast, and no engine option is needed (docs/architecture.md)").toBeGreaterThan(3);
      }
    });
  });

  describe(`${name}: the standard's Table 16 (Property-Property Comparisons), on its test data`, () => {
    const columns = Object.fromEntries(Object.entries(PLACES_QUERYABLES).map(([n, q]) => [
      n, { ...q, sqlType: "format" in q ? "TIMESTAMP WITH TIME ZONE" : q.type === "integer" ? "INTEGER" : "VARCHAR" },
    ])) as Record<string, SqlColumn>;
    beforeAll(async () => {
      const names = Object.keys(columns);
      await duck.run(`CREATE TABLE places (id INTEGER, ${names.map((n) => `"${n}" ${columns[n]!.sqlType}`).join(", ")})`);
      await duck.run(`INSERT INTO places VALUES ${places.map((f) => `(${[f.id, ...names.map((n) => f.properties[n])].map(sqlLiteral).join(", ")})`).join(", ")}`);
    });

    it.for(TABLE_16)("%s: %i", async ([text, expected]) => {
      const { where, params } = toSql(fromText(text), { dialect: "duckdb", columns });
      expect(Number((await rows(`SELECT count(*) FROM places WHERE ${where}`, params))[0]![0])).toBe(expected);
    });

    it.for(TABLE_17)("Table 17 (Arithmetic Expressions), %s: %i", async ([text, expected]) => {
      const { where, params } = toSql(fromText(text), { dialect: "duckdb", columns });
      expect(Number((await rows(`SELECT count(*) FROM places WHERE ${where}`, params))[0]![0])).toBe(expected);
    });
  });
}
