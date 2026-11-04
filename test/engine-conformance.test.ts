/**
 * `evaluateConformance` and `sqlConformance`: the classes each engine evaluates with its options, and the promise
 * that makes them useful: a filter valid against the list (`validate(f, { conformance })`) is never refused as
 * `unsupported` with the same options, and a filter the list refuses (`needs-conformance`) always is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { evaluateConformance, toEvaluator, type SpatialEngine } from "ogc-cql2/evaluate";
import { sqlConformance, toSql, type SqlOptions } from "ogc-cql2/sql";
import { filterProperties, validate } from "ogc-cql2/validate";
import { generateArithmeticFilters, generateFilters, generatePropertyFilters, generateTemporalFilters } from "./corpus.ts";
import { leaf, LITERALS } from "./spatial-cases.ts";

/** An engine that is never called: the lists depend on whether one is given, not on what it answers. */
const engine: SpatialEngine = { prepare: () => ({ relate: () => "FFFFFFFF2" }) };

const ALL = Object.values(CONFORMANCE);
const BUT_SPATIAL = ALL.filter((c) => c !== CONFORMANCE.spatial);

describe("the lists", () => {
  it("evaluate: every class but Spatial Functions; with a spatialEngine, every class", () => {
    expect(evaluateConformance()).toEqual(BUT_SPATIAL);
    expect(evaluateConformance({})).toEqual(BUT_SPATIAL);
    expect(evaluateConformance({ spatialEngine: engine })).toEqual(ALL);
  });

  it("sql: every class on postgres, duckdb and oracle; on sqlite, Spatial Functions only with SpatiaLite; on sqlserver, all but Spatial Functions", () => {
    expect(sqlConformance({ dialect: "postgres" })).toEqual(ALL);
    expect(sqlConformance({ dialect: "duckdb" })).toEqual(ALL);
    expect(sqlConformance({ dialect: "sqlite" })).toEqual(BUT_SPATIAL);
    expect(sqlConformance({ dialect: "sqlite", spatialite: false })).toEqual(BUT_SPATIAL);
    expect(sqlConformance({ dialect: "sqlite", spatialite: true })).toEqual(ALL);
    expect(sqlConformance({ dialect: "oracle" })).toEqual(ALL);
    expect(sqlConformance({ dialect: "sqlserver" })).toEqual(BUT_SPATIAL);
  });

  it("the guard: a class added to CONFORMANCE is in every list that has all of them", () => {
    // Written out, so that adding a class to CONFORMANCE without deciding where it is evaluated fails here.
    expect(ALL).toHaveLength(10);
    expect(evaluateConformance({ spatialEngine: engine })).toEqual(ALL);
  });

  it("the options toPredicate and toSql take fit as they are", () => {
    const sqlOptions: SqlOptions = { dialect: "sqlite", columns: {}, spatialite: true };
    expect(sqlConformance(sqlOptions)).toEqual(ALL);
    expect(sqlConformance({ dialect: "postgres", columns: {}, functionSchema: "cql2" })).toEqual(ALL);
    expect(evaluateConformance({ spatialEngine: engine, getProperty: () => null, geometryProperty: "g" })).toEqual(ALL);
  });

  it("a new array each time, to change at will", () => {
    const a = evaluateConformance();
    a.push("x");
    a.splice(0, 1);
    expect(evaluateConformance()).toEqual(BUT_SPATIAL);
    const b = sqlConformance({ dialect: "postgres" });
    b.length = 0;
    expect(sqlConformance({ dialect: "postgres" })).toEqual(ALL);
  });
});

// --- The promise ---------------------------------------------------------------------------------------------------

const dir = new URL("./fixtures/ogc/examples/json/", import.meta.url);
const examples = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(new URL(name, dir), "utf8")) as unknown);
const SPATIAL_OPS = ["s_intersects", "s_disjoint", "s_equals", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"];
const properties = ["s", "n", "d", "t"];
const FILTERS: Cql2Filter[] = [
  ...examples,
  ...SPATIAL_OPS.flatMap((op) => LITERALS.map((l) => ({ ...leaf(l), op }))),
  ...generateFilters(properties).filter((_, i) => i % 5 === 0),
  ...generatePropertyFilters(properties).filter((_, i) => i % 3 === 0),
  ...generateArithmeticFilters(properties).filter((_, i) => i % 3 === 0),
  ...generateTemporalFilters(properties).filter((_, i) => i % 5 === 0),
].filter((f) => validate(f).valid) as Cql2Filter[];

const codeOf = (compile: () => unknown): string | undefined => {
  try {
    compile();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

const ENGINES: [string, string[], (f: Cql2Filter) => unknown][] = [
  ["evaluate", evaluateConformance(), (f) => toEvaluator(f)],
  ["evaluate with a spatialEngine", evaluateConformance({ spatialEngine: engine }), (f) => toEvaluator(f, { spatialEngine: engine })],
  ...(["sqlite", "postgres", "duckdb", "oracle", "sqlserver"] as const).flatMap((dialect) =>
    [false, true].map((spatialite): [string, string[], (f: Cql2Filter) => unknown] => [
      `${dialect}${spatialite ? " with spatialite" : ""}`,
      sqlConformance({ dialect, spatialite }),
      (f) => toSql(f, { dialect, spatialite, columns: Object.fromEntries(filterProperties(f).map((n) => [n, {}])) }),
    ]),
  ),
];

describe("the promise: valid against the list exactly when not refused as unsupported", () => {
  it.for(ENGINES)("%s", ([, conformance, compile]) => {
    expect(FILTERS.length).toBeGreaterThan(5000);
    let refused = 0;
    const wrong: string[] = [];
    for (const f of FILTERS) {
      const result = validate(f, { conformance });
      const needs = !result.valid && result.problems.some((p) => p.code === "needs-conformance");
      if (needs) refused++;
      // Every filter compiles, or is refused as unsupported: nothing else, so each one really is tested.
      const code = codeOf(() => compile(f));
      if (code !== (needs ? "unsupported" : undefined)) wrong.push(`${code}: ${JSON.stringify(f).slice(0, 160)}`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    if (conformance.length < ALL.length) expect(refused).toBeGreaterThan(100); // the refusing side is exercised too
  });
});
