/**
 * Four stores, one answer: the kitchen sink from its GeoJSON file (`evaluate`), from the GeoPackage (SQLite), from its
 * GeoParquet file (DuckDB, with GDAL's float32 bbox covering) and from PostgreSQL must give exactly the same features
 * (ids, properties, geometry) for every generated filter. The PostgreSQL part runs when the database named by `.env` has the loaded `cql2demo` schema (load-postgres.sh);
 * otherwise it is skipped, with the reason.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Cql2Filter } from "ogc-cql2";
import { validate } from "ogc-cql2/validate";
import { openDuckDB, openGeoParquet, type DuckDB } from "../src/stores/duckdb.ts";
import { createGeoJsonStore } from "../src/stores/geojson.ts";
import { openGeoPackage } from "../src/stores/geopackage.ts";
import { createOraclePool, openOracle } from "../src/stores/oracle.ts";
import { createPool, openPostgres } from "../src/stores/postgres.ts";
import { createSqlServerPool, openSqlServer } from "../src/stores/sqlserver.ts";
import type { Feature, Store } from "../src/stores/types.ts";
import { CONFORMANCE } from "ogc-cql2";

const file = JSON.parse(readFileSync(new URL("../data/kitchen_sink.geojson", import.meta.url), "utf8"));
const fromFile = createGeoJsonStore({ id: "kitchen_sink", title: "Kitchen sink" }, file);
const gpkgPath = new URL("../data/usa.gpkg", import.meta.url).pathname;
const fromGpkg = openGeoPackage({ file: gpkgPath, tables: ["kitchen_sink"] }).stores[0]!.store;

let duck: DuckDB | undefined;
let fromParquet: Store;
let pool: ReturnType<typeof createPool> | undefined;
let fromPg: Store | undefined;
let fromPg3857: Store | undefined;
let pgSkip = "";
let oraclePool: Awaited<ReturnType<typeof createOraclePool>> | undefined;
let fromOracle: Store | undefined;
/** The same rows with neither USER_SDO_GEOM_METADATA nor a spatial index. */
let fromOraclePlain: Store | undefined;
/** `evaluate` on the features Oracle serves (its text in NFC, its '' NULL): what the Oracle store must select. */
let fromOracleServed: Store | undefined;
let oracleSkip = "";
let sqlServerPool: Awaited<ReturnType<typeof createSqlServerPool>> | undefined;
let fromSqlServer: Store | undefined;
/** `evaluate` on the features SQL Server serves (its text in NFC): what the SQL Server store must select. */
let fromSqlServerServed: Store | undefined;
let sqlServerSkip = "";

before(async () => {
  duck = await openDuckDB();
  fromParquet = await openGeoParquet(duck, { id: "kitchen_sink", title: "Kitchen sink", file: new URL("../data/kitchen_sink.parquet", import.meta.url).pathname });
}, { timeout: 120_000 }); // INSTALL downloads DuckDB's spatial extension on a fresh machine
before(async () => {
  if (!process.env.PGDATABASE) {
    pgSkip = "no PGDATABASE: run the tests with demo-server's .env (npm test does)";
    return;
  }
  pool = createPool();
  try {
    const { stores, warnings } = await openPostgres(pool, {
      functionSchema: "cql2demo",
      tables: [{ table: "cql2demo.kitchen_sink" }, { table: "cql2demo.kitchen_sink_3857" }],
    });
    fromPg = stores.find((s) => s.id === "kitchen_sink")?.store;
    fromPg3857 = stores.find((s) => s.id === "kitchen_sink_3857")?.store;
    if (!fromPg || warnings.some((w) => /cql2_\* functions/.test(w))) pgSkip = `cql2demo isn't loaded (${warnings.join(" ")})`;
  } catch (error) {
    pgSkip = `PostgreSQL isn't reachable: ${(error as Error).message}`;
  }
});
before(async () => {
  if (!process.env.ORACLE_CONNECT) {
    oracleSkip = "no ORACLE_CONNECT: add Oracle's connection to demo-server's .env (see data/load-oracle.ts)";
    return;
  }
  try {
    oraclePool = await createOraclePool();
    const { stores, warnings } = await openOracle(oraclePool, {
      tables: [{ table: "KITCHEN_SINK", days: ["day"] }, { table: "KITCHEN_SINK_PLAIN", days: ["day"] }],
    });
    fromOracle = stores.find((s) => s.id === "kitchen_sink")?.store;
    fromOraclePlain = stores.find((s) => s.id === "kitchen_sink_plain")?.store;
    if (!fromOracle || warnings.some((w) => /cql2_\* functions/.test(w))) {
      oracleSkip = `the kitchen sink isn't loaded in Oracle (${warnings.join(" ")}): run data/load-oracle.ts`;
      return;
    }
    const served = (await fromOracle.query(true, { limit: 1000, offset: 0 })).features;
    fromOracleServed = createGeoJsonStore({ id: "kitchen_sink", title: "Kitchen sink" }, { type: "FeatureCollection", features: served });
  } catch (error) {
    oracleSkip = `Oracle isn't reachable: ${(error as Error).message}`;
  }
}, { timeout: 60_000 });
before(async () => {
  if (!process.env.MSSQL_DATABASE) {
    sqlServerSkip = "no MSSQL_DATABASE: add SQL Server's connection to demo-server's .env (see data/load-sqlserver.ts)";
    return;
  }
  try {
    sqlServerPool = await createSqlServerPool();
    const { stores, warnings } = await openSqlServer(sqlServerPool, { tables: [{ table: "dbo.kitchen_sink" }] });
    fromSqlServer = stores.find((s) => s.id === "kitchen_sink")?.store;
    if (!fromSqlServer || warnings.some((w) => /cql2_\* functions/.test(w))) {
      sqlServerSkip = `the kitchen sink isn't loaded in SQL Server (${warnings.join(" ")}): run data/load-sqlserver.ts`;
      return;
    }
    const served = (await fromSqlServer.query(true, { limit: 1000, offset: 0 })).features;
    fromSqlServerServed = createGeoJsonStore({ id: "kitchen_sink", title: "Kitchen sink" }, { type: "FeatureCollection", features: served });
  } catch (error) {
    sqlServerSkip = `SQL Server isn't reachable: ${(error as Error).message}`;
  }
}, { timeout: 60_000 });
after(async () => {
  await sqlServerPool?.close();
  await oraclePool?.close(0);
  await pool?.end();
  duck?.close();
});

// --- The filters -------------------------------------------------------------------------------------------------

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const accenti = (arg: unknown) => ({ op: "accenti", args: [arg] });
const PROPERTIES = ["name", "code", "small", "count", "big", "ratio", "amount", "active", "day", "at", "local_at", "until", "note"];
const LITERALS: unknown[] = [
  "Straße", "STRASSE", "straße", "café", "café", "", "😀", "", "Riv", "river", "a_b", "Ελλάδα", "ΣΊΣΥΦΟΣ", "100%",
  "5", "2020-07-26", "2023-01-01T00:00:00.000Z", "2023-01-01T10:00:00.000", "end\\", "Å", "O'Brien",
  0, 1, -1, 2.5, 5, 12.34, 1e21, 9007199254740991, true, false,
  { date: "2020-07-26" }, { date: "2023-01-01" }, { date: "1970-01-01" },
  { timestamp: "2023-01-01T00:00:00Z" }, { timestamp: "2023-01-01T00:00:00.001Z" }, { timestamp: "2022-12-31T23:00:00Z" },
];
const PATTERNS = ["%", "_%", "", "Stra%", "%ss%", "%SS%", "100\\%", "a\\_b", "a_b", "%é", "ri%", "Ri_", "_", "%😀%", "end\\", "%T%", "%2023%"];

function generate(): Cql2Filter[] {
  const leaves: unknown[] = [true, false];
  for (const name of PROPERTIES) {
    leaves.push({ op: "isNull", args: [p(name)] });
    for (const value of LITERALS) for (const op of ["=", "<>", "<", "<=", ">", ">="]) leaves.push({ op, args: [p(name), value] });
    for (const value of LITERALS.filter((v) => typeof v === "string")) {
      leaves.push({ op: "=", args: [casei(p(name)), casei(value)] }, { op: "<", args: [casei(p(name)), value] });
      leaves.push({ op: "=", args: [accenti(p(name)), accenti(value)] }, { op: "<", args: [casei(accenti(p(name))), casei(accenti(value))] });
    }
    for (const pattern of PATTERNS) {
      leaves.push({ op: "like", args: [p(name), pattern] }, { op: "like", args: [casei(p(name)), casei(pattern)] });
      leaves.push({ op: "like", args: [accenti(casei(p(name))), accenti(casei(pattern))] });
    }
    leaves.push({ op: "between", args: [p(name), 0, 5] }, { op: "between", args: [p(name), -1, 2.5] });
    for (const list of [["Straße", "café"], [5, 10], [true], [{ date: "2020-07-26" }, { date: "1999-12-31" }], [{ timestamp: "2023-01-01T00:00:00Z" }]]) {
      leaves.push({ op: "in", args: [p(name), list] });
    }
  }
  const valid = leaves.filter((f) => validate(f).valid) as Cql2Filter[];
  const set = [...valid, ...valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter)];
  for (let i = 0; i + 1 < valid.length; i += 7) {
    set.push({ op: "and", args: [valid[i]!, valid[i + 1]!] }, { op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });
  }
  return set;
}
const FILTERS = generate();
const PAGE = { limit: 1000, offset: 0 };

/**
 * Property-Property Comparisons: every pair of the properties (plain, and under CASEI / ACCENTI), literals on the left,
 * BETWEEN and IN with properties, under NOT, AND and OR; only what the queryables allow (two kinds that can't be
 * compared are refused by validate, and by toSql).
 */
function generatePairs(): Cql2Filter[] {
  const leaves: unknown[] = [];
  for (const a of PROPERTIES) {
    for (const b of PROPERTIES) {
      for (const op of ["=", "<>", "<", "<=", ">", ">="]) leaves.push({ op, args: [p(a), p(b)] });
      leaves.push({ op: "=", args: [casei(p(a)), casei(p(b))] }, { op: "<", args: [accenti(p(a)), p(b)] });
      leaves.push({ op: "between", args: [p(a), p(b), 10] }, { op: "in", args: [p(a), [p(b), 5]] }, { op: "in", args: [p(a), [p(b), "Straße"]] });
    }
    for (const value of LITERALS.filter((_, i) => i % 2 === 0)) for (const op of ["=", "<", ">="]) leaves.push({ op, args: [value, p(a)] });
  }
  const queryables = fromFile.queryables();
  const valid = leaves.filter((f) => validate(f, { queryables }).valid) as Cql2Filter[];
  const set = [...valid, ...valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter)];
  for (let i = 0; i + 1 < valid.length; i += 5) set.push({ op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });
  return set;
}
const PAIRS = generatePairs();

/**
 * Arithmetic Expressions on the number columns: each operator with literals (zero divisors, signs, fractions, 1e308
 * and 1e-320 for overflow and underflow) and with another column, nested, scaled, in BETWEEN and IN, under NOT and OR.
 * Powers only with whole exponents, whose results are exact.
 */
function generateArithmetic(): Cql2Filter[] {
  const numbers = ["small", "count", "big", "ratio", "amount"];
  const ops = ["+", "-", "*", "/", "%", "div"];
  const values = [0, 1, -1, 2, 0.5, 7.5, 1e308, 1e-320];
  const e = (op: string, a: unknown, b: unknown) => ({ op, args: [a, b] });
  const leaves: unknown[] = [];
  for (const a of numbers) {
    for (const op of ops) {
      for (const v of values) leaves.push({ op: ">", args: [e(op, p(a), v), 1] }, { op: "=", args: [e(op, v, p(a)), 0] });
      for (const b of numbers) leaves.push({ op: "<", args: [e(op, p(a), p(b)), 2] });
    }
    for (const x of [0, 1, 2, 3]) leaves.push({ op: "<=", args: [e("^", p(a), x), 100] });
    for (const b of numbers) leaves.push({ op: ">", args: [p(a), e("*", p(b), 0.001)] });
    leaves.push({ op: "between", args: [e("/", p(a), 2), -1, e("+", 1, 2)] }, { op: "in", args: [e("%", p(a), 3), [0, 1]] });
  }
  const queryables = fromFile.queryables();
  const valid = leaves.filter((f) => validate(f, { queryables }).valid) as Cql2Filter[];
  return [...valid, ...valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter), ...valid.filter((_, i) => i % 9 === 0).map((f, i) => ({ op: "or", args: [f, valid[i * 3 + 1] ?? f] }) as Cql2Filter)];
}
const ARITHMETIC = generateArithmetic();

/**
 * Temporal Functions: each function on the day and instant columns, against dates, timestamps and intervals (with
 * `'..'`, of zero length, on the data's own values) and against an interval of two columns (`at`, `until`: NULL ends,
 * equal ends, a start after its end), in either order, under NOT and OR.
 */
function generateTemporal(): Cql2Filter[] {
  const ops = [
    "t_after", "t_before", "t_disjoint", "t_equals", "t_intersects", "t_contains", "t_during", "t_finishedBy",
    "t_finishes", "t_meets", "t_metBy", "t_overlappedBy", "t_overlaps", "t_startedBy", "t_starts",
  ];
  const days = ["2020-07-26", "2023-01-01", "1970-01-01", "2021-01-01"];
  const instants = ["2023-01-01T00:00:00Z", "2023-01-01T00:00:00.001Z", "2023-12-31T23:59:59.999Z", "1970-01-01T00:00:00Z", "2023-06-15T12:00:00Z"];
  const intervals = [
    ...days.flatMap((a, i) => [[a, days[(i + 1) % days.length]!], [a, a], [a, ".."], ["..", a]]),
    ...instants.flatMap((a, i) => [[a, instants[(i + 2) % instants.length]!], [a, a], [a, ".."], ["..", a]]),
  ].map((interval) => ({ interval }));
  const literals = [...days.map((date) => ({ date })), ...instants.map((timestamp) => ({ timestamp })), ...intervals];
  const span = { interval: [p("at"), p("until")] };
  const leaves: unknown[] = [];
  for (const op of ops) {
    for (const l of literals) {
      for (const a of ["day", "at", "until"]) leaves.push({ op, args: [p(a), l] });
      leaves.push({ op, args: [span, l] }, { op, args: [l, span] });
    }
    leaves.push({ op, args: [span, p("at")] }, { op, args: [p("until"), span] }, { op, args: [span, { interval: [p("until"), ".."] }] });
  }
  const queryables = fromFile.queryables();
  const valid = leaves.filter((f) => validate(f, { queryables }).valid) as Cql2Filter[];
  const set = [...valid, ...valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter)];
  for (let i = 0; i + 1 < valid.length; i += 7) set.push({ op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });
  return set;
}
const TEMPORAL = generateTemporal();

async function differences(a: Store, b: Store, label: string): Promise<string[]> {
  const out: string[] = [];
  for (const filter of FILTERS) {
    const [x, y] = await Promise.all([a.query(filter, PAGE), b.query(filter, PAGE)]);
    if (!isDeepStrictEqual(x, y)) {
      out.push(`${JSON.stringify(filter)}\n    geojson ${x.features.map((f) => f.id)} / ${label} ${y.features.map((f) => f.id)}`);
    }
  }
  return out;
}

// --- Spatial filters: GeoJSON (evaluate), GeoPackage (cql2_intersects) and PostgreSQL (PostGIS) -------------------

/** Every position of the kitchen sink's geometries. */
const positions: number[][] = [];
const collect = (c: unknown): void => {
  if (Array.isArray(c) && typeof c[0] === "number") positions.push(c as number[]);
  else if (Array.isArray(c)) c.forEach(collect);
};
for (const f of file.features as { geometry: { coordinates?: unknown; geometries?: { coordinates: unknown }[] } | null }[]) {
  if (f.geometry?.coordinates) collect(f.geometry.coordinates);
  f.geometry?.geometries?.forEach((g) => collect(g.coordinates));
}
const s_intersects = (literal: unknown) => ({ op: "s_intersects", args: [p("geometry"), literal] });

/** Literals with some margin around the data: the same answers in any CRS the column is stored in. */
const SPATIAL_MARGIN: unknown[] = [
  // Offsets that can't land on the data's coordinates (whole numbers and two decimals).
  ...positions.map(([x, y]) => s_intersects({ bbox: [x! - 0.5137, y! - 0.4871, x! + 0.5213, y! + 0.4789] })),
  ...positions.map(([x, y]) => s_intersects({ bbox: [x! + 0.1093, y! + 0.1171, x! + 2.9137, y! + 3.0571] })),
  s_intersects({ bbox: [-10, 35, 30, 60] }),
  s_intersects({ bbox: [170, -80, -170, 80] }),
  s_intersects({ type: "Polygon", coordinates: [[[-5, 35], [30, 35], [30, 55], [-5, 55], [-5, 35]], [[0, 40], [10, 40], [10, 50], [0, 50], [0, 40]]] }),
  s_intersects({ type: "LineString", coordinates: [[-10, 40], [30, 50]] }),
  { op: "not", args: [s_intersects({ bbox: [-10, 35, 30, 60] })] },
  { op: "and", args: [s_intersects({ bbox: [-10, 35, 30, 60] }), { op: "like", args: [p("name"), "%a%"] }] },
];
/** And literals exactly on the data's vertices: for a column stored as given (4326). */
const SPATIAL_EXACT: unknown[] = [
  ...positions.map((c) => s_intersects({ type: "Point", coordinates: c })),
  ...positions.map(([x, y]) => s_intersects({ bbox: [x!, y!, x! + 1, y! + 1] })),
  ...positions.map(([x, y]) => s_intersects({ bbox: [x! - 1, y! - 1, x!, y!] })),
];

/** The other relations, on the same literals (with margin, and exactly on vertices), for the stores that evaluate them. */
const RELATIONS = ["s_equals", "s_disjoint", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"];
const relation = (op: string) => (f: unknown) => ({ ...(f as object), op });
const RELATIONS_MARGIN = RELATIONS.flatMap((op) => SPATIAL_MARGIN.filter((f) => (f as { op: string }).op === "s_intersects").map(relation(op)));
const RELATIONS_EXACT = RELATIONS.flatMap((op) => [
  ...SPATIAL_EXACT.map(relation(op)),
  // Each feature's own geometry, as the literal: S_EQUALS, S_WITHIN and S_CONTAINS select it.
  ...(file.features as { geometry: { type: string } | null }[])
    .filter((f) => f.geometry && f.geometry.type !== "GeometryCollection" && validate(s_intersects(f.geometry)).valid)
    .map((f) => ({ op, args: [p("geometry"), f.geometry] })),
]);

/** Each spatial leaf with its literal first, the relation its converse (S_WITHIN ↔ S_CONTAINS): the same features. */
const literalFirst = (f: unknown): unknown => {
  if (typeof f !== "object" || f === null || typeof (f as { op?: unknown }).op !== "string") return f; // a literal
  const { op, args } = f as { op: string; args: unknown[] };
  if (op.startsWith("s_") && "property" in (args[0] as object)) {
    return { op: op === "s_within" ? "s_contains" : op === "s_contains" ? "s_within" : op, args: [args[1], args[0]] };
  }
  return { op, args: args.map(literalFirst) };
};

async function spatialDifferences(store: Store, filters: unknown[], label: string): Promise<string[]> {
  const out: string[] = [];
  for (const filter of filters) {
    const [x, y] = await Promise.all([fromFile.query(filter as Cql2Filter, PAGE), store.query(filter as Cql2Filter, PAGE)]);
    const ids = (r: { features: readonly Feature[] }) => r.features.map((f) => f.id).join(",");
    if (ids(x) !== ids(y)) out.push(`${JSON.stringify(filter).slice(0, 140)}\n    geojson ${ids(x)} / ${label} ${ids(y)}`);
  }
  return out;
}

describe("the kitchen sink, four stores", () => {
  it("the same queryables", (t) => {
    assert.deepEqual(fromGpkg.queryables(), fromFile.queryables());
    assert.deepEqual(fromParquet.queryables(), fromFile.queryables());
    if (pgSkip) return t.skip(pgSkip);
    assert.deepEqual(fromPg!.queryables(), fromFile.queryables());
  });

  it(`${FILTERS.length} filters: GeoJSON and GeoPackage give the same features`, async () => {
    assert.ok(FILTERS.length > 3000);
    assert.equal((await differences(fromFile, fromGpkg, "geopackage")).slice(0, 10).join("\n"), "");
  });

  it(`${FILTERS.length} filters: GeoJSON and GeoParquet (DuckDB) give the same features`, async () => {
    assert.equal((await differences(fromFile, fromParquet, "geoparquet")).slice(0, 10).join("\n"), "");
  });

  it(`${FILTERS.length} filters: GeoJSON and PostgreSQL give the same features`, async (t) => {
    if (pgSkip) return t.skip(pgSkip);
    assert.equal((await differences(fromFile, fromPg!, "postgres")).slice(0, 10).join("\n"), "");
  });

  for (const [label, store] of [["GeoPackage", () => fromGpkg], ["GeoParquet (DuckDB)", () => fromParquet], ["PostgreSQL", () => fromPg]] as const) {
    it(`Property-Property Comparisons, ${PAIRS.length} filters: GeoJSON and ${label} give the same features`, async (t) => {
      if (label === "PostgreSQL" && pgSkip) return t.skip(pgSkip);
      assert.ok(PAIRS.length > 1000, `${PAIRS.length} filters`);
      const out: string[] = [];
      for (const filter of PAIRS) {
        const [x, y] = await Promise.all([fromFile.query(filter, PAGE), store()!.query(filter, PAGE)]);
        if (!isDeepStrictEqual(x.features.map((f) => f.id), y.features.map((f) => f.id))) {
          out.push(`${JSON.stringify(filter)}\n    geojson ${x.features.map((f) => f.id)} / ${label} ${y.features.map((f) => f.id)}`);
        }
      }
      assert.equal(out.slice(0, 10).join("\n"), "");
    });

    it(`Arithmetic Expressions, ${ARITHMETIC.length} filters: GeoJSON and ${label} give the same features`, async (t) => {
      if (label === "PostgreSQL" && pgSkip) return t.skip(pgSkip);
      assert.ok(ARITHMETIC.length > 500, `${ARITHMETIC.length} filters`);
      const out: string[] = [];
      for (const filter of ARITHMETIC) {
        const [x, y] = await Promise.all([fromFile.query(filter, PAGE), store()!.query(filter, PAGE)]);
        if (!isDeepStrictEqual(x.features.map((f) => f.id), y.features.map((f) => f.id))) {
          out.push(`${JSON.stringify(filter)}\n    geojson ${x.features.map((f) => f.id)} / ${label} ${y.features.map((f) => f.id)}`);
        }
      }
      assert.equal(out.slice(0, 10).join("\n"), "");
    });

    it(`Temporal Functions, ${TEMPORAL.length} filters: GeoJSON and ${label} give the same features`, async (t) => {
      if (label === "PostgreSQL" && pgSkip) return t.skip(pgSkip);
      assert.ok(TEMPORAL.length > 1000, `${TEMPORAL.length} filters`);
      const out: string[] = [];
      for (const filter of TEMPORAL) {
        const [x, y] = await Promise.all([fromFile.query(filter, PAGE), store()!.query(filter, PAGE)]);
        if (!isDeepStrictEqual(x.features.map((f) => f.id), y.features.map((f) => f.id))) {
          out.push(`${JSON.stringify(filter)}\n    geojson ${x.features.map((f) => f.id)} / ${label} ${y.features.map((f) => f.id)}`);
        }
      }
      assert.equal(out.slice(0, 10).join("\n"), "");
    });

    it(`the literal first, every spatial filter: GeoJSON and ${label} give the same features`, async (t) => {
      if (label === "PostgreSQL" && pgSkip) return t.skip(pgSkip);
      const relations = label !== "GeoPackage" || store().conformance().includes(CONFORMANCE.spatial);
      const filters = [...SPATIAL_MARGIN, ...SPATIAL_EXACT, ...(relations ? [...RELATIONS_MARGIN, ...RELATIONS_EXACT] : [])].map(literalFirst);
      assert.equal((await spatialDifferences(store()!, filters, label)).slice(0, 10).join("\n"), "");
    });
  }

  it("the test is not trivial: the filters select many different sets", async () => {
    const sets = new Set<string>();
    for (const filter of FILTERS) sets.add(JSON.stringify((await fromFile.query(filter, PAGE)).features.map((f) => f.id)));
    assert.ok(sets.size > 150, `${sets.size} different results`);
    const temporal = new Set<string>();
    for (const filter of TEMPORAL) temporal.add(JSON.stringify((await fromFile.query(filter, PAGE)).features.map((f) => f.id)));
    assert.ok(temporal.size > 90, `Temporal Functions: ${temporal.size} different results`); // 102 measured
  });

  it(`spatial filters: GeoJSON and GeoPackage give the same features, also exactly on vertices`, async () => {
    assert.equal((await spatialDifferences(fromGpkg, [...SPATIAL_MARGIN, ...SPATIAL_EXACT], "geopackage")).slice(0, 10).join("\n"), "");
  });

  it(`spatial filters: GeoJSON and GeoParquet (DuckDB, with the covering) give the same features, also exactly on vertices`, async () => {
    assert.equal((await spatialDifferences(fromParquet, [...SPATIAL_MARGIN, ...SPATIAL_EXACT], "geoparquet")).slice(0, 10).join("\n"), "");
  });

  it(`the other relations: GeoJSON (evaluate with GEOS) and GeoParquet (DuckDB, with the covering) give the same features, also exactly on vertices`, async () => {
    assert.equal((await spatialDifferences(fromParquet, [...RELATIONS_MARGIN, ...RELATIONS_EXACT], "geoparquet")).slice(0, 10).join("\n"), "");
  });

  it(`spatial filters: GeoJSON and PostgreSQL (4326) give the same features, also exactly on vertices`, async (t) => {
    if (pgSkip) return t.skip(pgSkip);
    assert.equal((await spatialDifferences(fromPg!, [...SPATIAL_MARGIN, ...SPATIAL_EXACT], "postgres")).slice(0, 10).join("\n"), "");
  });

  it(`the other relations: GeoJSON (evaluate with GEOS) and PostgreSQL (4326) give the same features, also exactly on vertices`, async (t) => {
    if (pgSkip) return t.skip(pgSkip);
    assert.ok(RELATIONS_EXACT.length > 500, `${RELATIONS_EXACT.length} filters`);
    assert.equal((await spatialDifferences(fromPg!, [...RELATIONS_MARGIN, ...RELATIONS_EXACT], "postgres")).slice(0, 10).join("\n"), "");
  });

  it(`the other relations: GeoJSON (evaluate with GEOS) and GeoPackage (SpatiaLite) give the same features, also exactly on vertices`, async (t) => {
    if (!fromGpkg.conformance().includes(CONFORMANCE.spatial)) return t.skip("SpatiaLite (mod_spatialite) isn't installed");
    assert.equal((await spatialDifferences(fromGpkg, [...RELATIONS_MARGIN, ...RELATIONS_EXACT], "geopackage")).slice(0, 10).join("\n"), "");
  });

  it(`the other relations: PostgreSQL in Web Mercator gives the same features (with margin)`, async (t) => {
    if (pgSkip || !fromPg3857) return t.skip(pgSkip || "kitchen_sink_3857 isn't loaded");
    assert.equal((await spatialDifferences(fromPg3857, RELATIONS_MARGIN, "postgres 3857")).slice(0, 10).join("\n"), "");
  });

  it(`spatial filters: PostgreSQL in Web Mercator gives the same features (with margin; its vertices moved in the round trip)`, async (t) => {
    if (pgSkip || !fromPg3857) return t.skip(pgSkip || "kitchen_sink_3857 isn't loaded");
    assert.equal((await spatialDifferences(fromPg3857, SPATIAL_MARGIN, "postgres 3857")).slice(0, 10).join("\n"), "");
    const exact = await spatialDifferences(fromPg3857, SPATIAL_EXACT, "postgres 3857");
    t.diagnostic(`literals exactly on the 4326 vertices: ${exact.length} of ${SPATIAL_EXACT.length} differ for the 3857 table`);
  });

  it("PostgreSQL in Web Mercator: the same rows; geometry converted back to WGS 84", async (t) => {
    if (pgSkip || !fromPg3857) return t.skip(pgSkip || "kitchen_sink_3857 isn't loaded");
    const a = (await fromPg!.query(true, PAGE)).features;
    const b = (await fromPg3857.query(true, PAGE)).features;
    assert.deepEqual(b.map((f) => [f.id, f.properties]), a.map((f) => [f.id, f.properties]));
    const close = (x: unknown, y: unknown): boolean =>
      typeof x === "number" && typeof y === "number" ? Math.abs(x - y) < 1e-9
        : Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => close(v, y[i]))
        : typeof x === "object" && x !== null && typeof y === "object" && y !== null
          ? Object.keys(x).length === Object.keys(y).length && Object.keys(x).every((k) => close((x as never)[k], (y as never)[k]))
          : x === y;
    b.forEach((f: Feature, i) => assert.ok(close(f.geometry, a[i]!.geometry), `feature ${f.id}`));
  });
});

describe("the kitchen sink in Oracle", () => {
  const PAGE_ALL = { limit: 1000, offset: 0 };

  it("the same queryables as the file", (t) => {
    if (oracleSkip) return t.skip(oracleSkip);
    assert.deepEqual(fromOracle!.queryables(), fromFile.queryables());
  });

  it("serves the file's values, but for the documented rules: text in NFC, and '' as NULL", async (t) => {
    if (oracleSkip) return t.skip(oracleSkip);
    const served = (await fromOracle!.query(true, PAGE_ALL)).features;
    const changed: string[] = [];
    for (const f of (await fromFile.query(true, PAGE_ALL)).features) {
      const o = served.find((x) => x.id === f.id)!;
      for (const [k, v] of Object.entries(f.properties)) if (!isDeepStrictEqual(o.properties[k], v)) changed.push(`${f.id}.${k}: ${JSON.stringify(v)} → ${JSON.stringify(o.properties[k])}`);
    }
    assert.deepEqual(changed, [
      `5.name: "cafe\u0301" → "café"`, // NFD → NFC
      `5.code: "" → null`,
      `10.note: "" → null`,
      `12.name: "" → null`,
      `17.name: "\u212bngström" → "Ångström"`, // U+212B ANGSTROM SIGN, whose NFC is U+00C5
    ]);
  });

  it("serves the file's geometries, the rings in Oracle's orientation", async (t) => {
    if (oracleSkip) return t.skip(oracleSkip);
    const served = (await fromOracle!.query(true, PAGE_ALL)).features;
    // The same geometry as the file's when each ring is read in either direction.
    const canonical = (g: unknown): unknown => JSON.stringify(g, (_, v) =>
      Array.isArray(v) && Array.isArray(v[0]) && typeof v[0][0] === "number" && v.length > 3 && JSON.stringify(v[0]) === JSON.stringify(v.at(-1))
        ? [...v].sort((a, b) => a[0] - b[0] || a[1] - b[1]) : v);
    const changed = (await fromFile.query(true, PAGE_ALL)).features.filter((f) => {
      const o = served.find((x) => x.id === f.id)!;
      return canonical(o.geometry) !== canonical(f.geometry);
    });
    assert.deepEqual(changed.map((f) => f.id), []);
    assert.deepEqual(served.map((f) => f.id).filter((id) => served.find((x) => x.id === id)!.geometry === null), [3, 11, 19]); // no geometry in the file
  });

  const spatialSets = [
    ["S_INTERSECTS", [...SPATIAL_MARGIN, ...SPATIAL_EXACT]],
    ["the other relations", [...RELATIONS_MARGIN, ...RELATIONS_EXACT]],
  ] as const;
  for (const [label, filters] of spatialSets) {
    for (const [index, store] of [["with the spatial index", () => fromOracle], ["without index or metadata", () => fromOraclePlain]] as const) {
      it(`${label}, ${filters.length * 2} filters (the literal first too), ${index}: Oracle selects what evaluate with GEOS selects`, async (t) => {
        if (oracleSkip) return t.skip(oracleSkip);
        const out: string[] = [];
        // Feature 8 is a GeometryCollection whose members meet (a point at a line's end): Oracle and GEOS read such a
        // collection differently for the relations but S_INTERSECTS and S_DISJOINT, the dialect's documented deviation.
        let collection = 0;
        for (const filter of [...filters, ...filters.map(literalFirst)] as Cql2Filter[]) {
          const [x, y] = await Promise.all([fromOracleServed!.query(filter, PAGE_ALL), store()!.query(filter, PAGE_ALL)]);
          const ids = (r: { features: readonly Feature[] }) => r.features.map((f) => f.id);
          const [a, b] = [ids(x), ids(y)];
          const differing = [...a.filter((id) => !b.includes(id)), ...b.filter((id) => !a.includes(id))];
          if (differing.length === 0) continue;
          const op = (filter as { op: string }).op;
          if (differing.every((id) => id === 8) && op !== "s_intersects" && op !== "s_disjoint") collection++;
          else out.push(`${JSON.stringify(filter).slice(0, 160)}\n    evaluate ${a} / oracle ${b}`);
        }
        assert.equal(out.slice(0, 10).join("\n"), "");
        t.diagnostic(`${collection} answers differ on feature 8 (a collection whose members meet: the documented deviation)`);
        assert.equal(collection, label === "S_INTERSECTS" ? 0 : 8);
      });
    }
  }

  for (const [label, filters] of [["base", FILTERS], ["Property-Property", PAIRS], ["Arithmetic", ARITHMETIC], ["Temporal", TEMPORAL]] as const) {
    it(`${label}, ${filters.length} filters: Oracle selects what evaluate selects from the features Oracle serves`, async (t) => {
      if (oracleSkip) return t.skip(oracleSkip);
      const out: string[] = [];
      for (const filter of filters) {
        const [x, y] = await Promise.all([fromOracleServed!.query(filter, PAGE_ALL), fromOracle!.query(filter, PAGE_ALL)]);
        if (!isDeepStrictEqual(x, y)) out.push(`${JSON.stringify(filter)}\n    evaluate ${x.features.map((f) => f.id)} / oracle ${y.features.map((f) => f.id)}`);
      }
      assert.equal(out.slice(0, 10).join("\n"), "");
    });
  }
});

describe("the kitchen sink in SQL Server (Basic Spatial Functions)", () => {
  const PAGE_ALL = { limit: 1000, offset: 0 };

  it("the same queryables as the file", (t) => {
    if (sqlServerSkip) return t.skip(sqlServerSkip);
    assert.deepEqual(fromSqlServer!.queryables(), fromFile.queryables());
  });

  it("serves the file's values, but for the documented rule: text in NFC ('' is kept)", async (t) => {
    if (sqlServerSkip) return t.skip(sqlServerSkip);
    const served = (await fromSqlServer!.query(true, PAGE_ALL)).features;
    const changed: string[] = [];
    for (const f of (await fromFile.query(true, PAGE_ALL)).features) {
      const o = served.find((x) => x.id === f.id)!;
      for (const [k, v] of Object.entries(f.properties)) if (!isDeepStrictEqual(o.properties[k], v)) changed.push(`${f.id}.${k}: ${JSON.stringify(v)} → ${JSON.stringify(o.properties[k])}`);
    }
    assert.deepEqual(changed, [
      `5.name: "café" → "café"`, // NFD → NFC
      `17.name: "Ångström" → "Ångström"`, // U+212B ANGSTROM SIGN, whose NFC is U+00C5
    ]);
  });

  it("serves the file's geometries exactly (WKB)", async (t) => {
    if (sqlServerSkip) return t.skip(sqlServerSkip);
    const served = (await fromSqlServer!.query(true, PAGE_ALL)).features;
    for (const f of (await fromFile.query(true, PAGE_ALL)).features) assert.deepEqual(served.find((x) => x.id === f.id)!.geometry, f.geometry, `feature ${f.id}`);
  });

  it(`S_INTERSECTS, ${(SPATIAL_MARGIN.length + SPATIAL_EXACT.length) * 4} filters (the literal first, and under NOT): SQL Server selects what evaluate selects`, async (t) => {
    if (sqlServerSkip) return t.skip(sqlServerSkip);
    const base = [...SPATIAL_MARGIN, ...SPATIAL_EXACT];
    const filters = [...base, ...base.map(literalFirst)].flatMap((f) => [f, { op: "not", args: [f] }]) as Cql2Filter[];
    const out: string[] = [];
    for (const filter of filters) {
      const [x, y] = await Promise.all([fromSqlServerServed!.query(filter, PAGE_ALL), fromSqlServer!.query(filter, PAGE_ALL)]);
      const ids = (r: { features: readonly Feature[] }) => r.features.map((f) => f.id).join(",");
      if (ids(x) !== ids(y)) out.push(`${JSON.stringify(filter).slice(0, 160)}\n    evaluate ${ids(x)} / sqlserver ${ids(y)}`);
    }
    assert.equal(out.slice(0, 10).join("\n"), "");
  });

  for (const [label, filters] of [["base", FILTERS], ["Property-Property", PAIRS], ["Arithmetic", ARITHMETIC], ["Temporal", TEMPORAL]] as const) {
    it(`${label}, ${filters.length} filters: SQL Server selects what evaluate selects from the features SQL Server serves`, async (t) => {
      if (sqlServerSkip) return t.skip(sqlServerSkip);
      const out: string[] = [];
      for (const filter of filters) {
        const [x, y] = await Promise.all([fromSqlServerServed!.query(filter, PAGE_ALL), fromSqlServer!.query(filter, PAGE_ALL)]);
        if (!isDeepStrictEqual(x, y)) out.push(`${JSON.stringify(filter)}\n    evaluate ${x.features.map((f) => f.id)} / sqlserver ${y.features.map((f) => f.id)}`);
      }
      assert.equal(out.slice(0, 10).join("\n"), "");
    });
  }
});
