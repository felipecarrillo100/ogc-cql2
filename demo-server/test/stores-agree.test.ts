/**
 * Three stores, one answer: the kitchen sink from its GeoJSON file (`evaluate`), from the GeoPackage (SQLite) and from
 * PostgreSQL must give exactly the same features (ids, properties, geometry) for every generated filter. The
 * PostgreSQL part runs when the database named by `.env` has the loaded `cql2demo` schema (load-postgres.sh);
 * otherwise it is skipped, with the reason.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Cql2Filter } from "ogc-cql2";
import { validate } from "ogc-cql2/validate";
import { createGeoJsonStore } from "../src/stores/geojson.ts";
import { openGeoPackage } from "../src/stores/geopackage.ts";
import { createPool, openPostgres } from "../src/stores/postgres.ts";
import type { Feature, Store } from "../src/stores/types.ts";

const file = JSON.parse(readFileSync(new URL("../data/kitchen_sink.geojson", import.meta.url), "utf8"));
const fromFile = createGeoJsonStore({ id: "kitchen_sink", title: "Kitchen sink" }, file);
const gpkgPath = new URL("../data/usa.gpkg", import.meta.url).pathname;
const fromGpkg = openGeoPackage({ file: gpkgPath, tables: ["kitchen_sink"] }).stores[0]!.store;

let pool: ReturnType<typeof createPool> | undefined;
let fromPg: Store | undefined;
let fromPg3857: Store | undefined;
let pgSkip = "";

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
after(() => pool?.end());

// --- The filters -------------------------------------------------------------------------------------------------

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const accenti = (arg: unknown) => ({ op: "accenti", args: [arg] });
const PROPERTIES = ["name", "code", "small", "count", "big", "ratio", "amount", "active", "day", "at", "local_at", "note"];
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

async function spatialDifferences(store: Store, filters: unknown[], label: string): Promise<string[]> {
  const out: string[] = [];
  for (const filter of filters) {
    const [x, y] = await Promise.all([fromFile.query(filter as Cql2Filter, PAGE), store.query(filter as Cql2Filter, PAGE)]);
    const ids = (r: { features: readonly Feature[] }) => r.features.map((f) => f.id).join(",");
    if (ids(x) !== ids(y)) out.push(`${JSON.stringify(filter).slice(0, 140)}\n    geojson ${ids(x)} / ${label} ${ids(y)}`);
  }
  return out;
}

describe("the kitchen sink, three stores", () => {
  it("the same queryables", (t) => {
    assert.deepEqual(fromGpkg.queryables(), fromFile.queryables());
    if (pgSkip) return t.skip(pgSkip);
    assert.deepEqual(fromPg!.queryables(), fromFile.queryables());
  });

  it(`${FILTERS.length} filters: GeoJSON and GeoPackage give the same features`, async () => {
    assert.ok(FILTERS.length > 3000);
    assert.equal((await differences(fromFile, fromGpkg, "geopackage")).slice(0, 10).join("\n"), "");
  });

  it(`${FILTERS.length} filters: GeoJSON and PostgreSQL give the same features`, async (t) => {
    if (pgSkip) return t.skip(pgSkip);
    assert.equal((await differences(fromFile, fromPg!, "postgres")).slice(0, 10).join("\n"), "");
  });

  it("the test is not trivial: the filters select many different sets", async () => {
    const sets = new Set<string>();
    for (const filter of FILTERS) sets.add(JSON.stringify((await fromFile.query(filter, PAGE)).features.map((f) => f.id)));
    assert.ok(sets.size > 150, `${sets.size} different results`);
  });

  it(`spatial filters: GeoJSON and GeoPackage give the same features, also exactly on vertices`, async () => {
    assert.equal((await spatialDifferences(fromGpkg, [...SPATIAL_MARGIN, ...SPATIAL_EXACT], "geopackage")).slice(0, 10).join("\n"), "");
  });

  it(`spatial filters: GeoJSON and PostgreSQL (4326) give the same features, also exactly on vertices`, async (t) => {
    if (pgSkip) return t.skip(pgSkip);
    assert.equal((await spatialDifferences(fromPg!, [...SPATIAL_MARGIN, ...SPATIAL_EXACT], "postgres")).slice(0, 10).join("\n"), "");
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
