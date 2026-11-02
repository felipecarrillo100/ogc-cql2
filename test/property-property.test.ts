/**
 * Property-Property Comparisons (OGC 21-065r2 §7.10, Requirement 17): a property on the right, a literal on the left.
 * The standard's own tests (Annex A.12): Table 16's counts on its test data (Conformance Test 49), the paired results
 * of tests 46–48, and the combinations of test 50; then what the standard leaves to the package (types, NULLs,
 * queryables) and the refusals.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { toEvaluator, toPredicate, type Truth } from "ogc-cql2/evaluate";
import { fromText } from "ogc-cql2/parse";
import { sqliteFunctions, toSql } from "ogc-cql2/sql";
import { toText } from "ogc-cql2/text";
import { assertValid, requiredConformance, validate } from "ogc-cql2/validate";
import { COLUMNS, readRow, ROWS } from "./awkward.ts";
import { geosEngine } from "./geos-engine.ts";
import { ALL, asGeoJson, FILTERS, literalFirst, LITERAL_FIRST, LITERAL_PAIRS, PAIR_FILTERS, pairsOf, RELATION_FILTERS } from "./spatial-cases.ts";
import { PLACES_QUERYABLES, places, sqlLiteral, TABLE_16 } from "./table16.ts";

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });

const count = (filter: Cql2Filter, queryables?: Readonly<Record<string, object>>) =>
  places.filter(toPredicate(filter, queryables ? { queryables } : {})).length;

describe("the standard's Table 16 (Conformance Test 49), on its own test data", () => {
  it.for(TABLE_16)("%s: %i", ([text, expected]) => {
    const filter = fromText(text, { queryables: PLACES_QUERYABLES });
    expect(count(filter, PLACES_QUERYABLES)).toBe(expected);
    expect(count(filter)).toBe(expected); // without queryables: the instants are UTC, written alike
    expect(requiredConformance(filter)).toContain(CONFORMANCE.propertyProperty);
  });

  it("each filter reads back from its CQL2-text", () => {
    for (const [text] of TABLE_16) {
      const filter = fromText(text);
      expect(fromText(toText(filter))).toEqual(filter);
    }
  });
});

describe("Table 16 in SQLite, typed as GeoPackage types it (TEXT, INTEGER, DATETIME)", () => {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);
  const names = Object.keys(PLACES_QUERYABLES);
  db.exec(`CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, nameascii TEXT, pop_min INTEGER, pop_max INTEGER,
           pop_other INTEGER, start DATETIME, "end" DATETIME, "date" DATE)`);
  db.exec(`INSERT INTO places VALUES ${places.map((f) => `(${[f.id, ...names.map((n) => f.properties[n])].map(sqlLiteral).join(", ")})`).join(", ")}`);

  it.for(TABLE_16)("%s: %i", ([text, expected]) => {
    const { where, params } = toSql(fromText(text), { dialect: "sqlite", columns: PLACES_QUERYABLES });
    expect((db.prepare(`SELECT count(*) AS n FROM places WHERE ${where}`).get(...(params as never[])) as { n: number }).n).toBe(expected);
  });
});

// --- Conformance Tests 46–48 ----------------------------------------------------------------------------------------

/** A value of each type, as the tests give them. */
const VALUES: Record<string, unknown> = {
  string: "foo", boolean: true, number: 3.14, integer: 1,
  "date-time": { timestamp: "2022-04-14T14:48:46Z" }, date: { date: "2022-04-14" },
};
const typeOf = (q: { type?: string; format?: string }) => q.format ?? q.type ?? "";
/** Each operator and the one that selects the rest: TRUE for one is FALSE for the other, NULL for both alike. */
const PAIRS = [["=", "<>"], [">", "<="], ["<", ">="]] as const;

/** Every row's three-valued result. */
const results = (rows: readonly unknown[], filter: unknown, options: object): Truth[] =>
  rows.map(toEvaluator(filter as Cql2Filter, options));

/** The data sources: OGC's places, and the SQLite test's awkward values (NaN and ±Infinity among them). */
const SOURCES = [
  { name: "OGC's populated places", rows: places, queryables: PLACES_QUERYABLES, get: undefined },
  {
    name: "the awkward-values table",
    rows: ROWS.map(readRow),
    queryables: COLUMNS,
    get: (row: Record<string, unknown>, name: string) => row[(COLUMNS[name] as { column?: string }).column ?? name],
  },
];

describe.for(SOURCES)("Conformance Tests 46–48, on $name", ({ rows, queryables, get }) => {
  const options = { queryables, ...(get ? { getProperty: get } : {}) };
  const typed = Object.entries(queryables).filter(([, q]) => typeOf(q) in VALUES);

  it("46: a value on the left; each pair of operators splits the rows that aren't NULL", () => {
    for (const [name, q] of typed) {
      for (const [op, other] of PAIRS) {
        const a = results(rows, { op, args: [VALUES[typeOf(q)], p(name)] }, options);
        const b = results(rows, { op: other, args: [VALUES[typeOf(q)], p(name)] }, options);
        a.forEach((t, i) => expect(t === null ? b[i] === null : b[i] === !t, `${name} ${op}/${other}, row ${i}`).toBe(true));
      }
    }
  });

  it("46: a value on the left is the property on the left with the operator mirrored", () => {
    const mirror: Record<string, string> = { "=": "=", "<>": "<>", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
    for (const [name, q] of typed) {
      for (const op of Object.keys(mirror)) {
        expect(results(rows, { op, args: [VALUES[typeOf(q)], p(name)] }, options))
          .toEqual(results(rows, { op: mirror[op], args: [p(name), VALUES[typeOf(q)]] }, options));
      }
    }
  });

  it("47: a property with itself: <>, < and > select nothing; =, >= and <= the same rows", () => {
    for (const [name] of typed) {
      const ids = (op: string) => results(rows, { op, args: [p(name), p(name)] }, options).map((t) => t === true);
      for (const op of ["<>", "<", ">"]) expect(ids(op).some(Boolean), `${name} ${op}`).toBe(false);
      expect(ids(">=")).toEqual(ids("="));
      expect(ids("<=")).toEqual(ids("="));
    }
  });

  it("48: a value with itself: <>, < and > are FALSE; =, >= and <= TRUE", () => {
    for (const value of Object.values(VALUES)) {
      for (const op of ["<>", "<", ">"]) expect(results(rows, { op, args: [value, value] }, options).every((t) => t === false)).toBe(true);
      for (const op of ["=", ">=", "<="]) expect(results(rows, { op, args: [value, value] }, options).every((t) => t === true)).toBe(true);
    }
  });
});

describe("Conformance Test 50: combinations of the stored predicates", () => {
  it("((NOT p1 AND p2) OR (p3 AND NOT p4) OR NOT (p1 AND p4)) gives the Kleene combination of its parts", () => {
    const predicates = TABLE_16.map(([text]) => fromText(text));
    const and = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === true && b === true ? true : null);
    const or = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === false && b === false ? false : null);
    const not = (a: Truth): Truth => (a === null ? null : !a);
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % predicates.length;
    for (let n = 0; n < 20; n++) {
      const [p1, p2, p3, p4] = [next(), next(), next(), next()].map((i) => predicates[i]!);
      const combined = {
        op: "or",
        args: [
          { op: "and", args: [{ op: "not", args: [p1] }, p2] },
          { op: "and", args: [p3, { op: "not", args: [p4] }] },
          { op: "not", args: [{ op: "and", args: [p1, p4] }] },
        ],
      } as Cql2Filter;
      const [r1, r2, r3, r4] = [p1, p2, p3, p4].map((f) => results(places, f, {}));
      const expected = places.map((_, i) => or(or(and(not(r1![i]!), r2![i]!), and(r3![i]!, not(r4![i]!))), not(and(r1![i]!, r4![i]!))));
      expect(results(places, combined, {})).toEqual(expected);
    }
  });
});

// --- What the standard leaves to the package ------------------------------------------------------------------------

const one = (filter: unknown, properties: Record<string, unknown>, queryables?: Readonly<Record<string, object>>): Truth =>
  toEvaluator(filter as Cql2Filter, queryables ? { queryables } : {})({ properties });

describe("evaluate: two properties, and the queryables", () => {
  const a = "2020-01-01T00:00:00Z";
  const b = "2020-01-01T01:00:00+01:00"; // the same instant, written with an offset
  const instants = { a: { type: "string", format: "date-time" }, b: { type: "string", format: "date-time" } };

  it("with queryables saying date-time, two instants compare as instants; without, as strings", () => {
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a, b }, instants)).toBe(true);
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a, b })).toBe(false);
    expect(one({ op: "<", args: [p("a"), p("b")] }, { a, b })).toBe(true); // "…00:00Z" < "…01:00+01:00" as text
  });

  it("with queryables, a value that isn't an instant is NULL, as against a timestamp literal", () => {
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a, b: "not a time" }, instants)).toBe(null);
    expect(one({ op: "=", args: [p("a"), { timestamp: a }] }, { a: "not a time" })).toBe(null);
  });

  it("dates with queryables saying date", () => {
    const dates = { a: { type: "string", format: "date" }, b: { type: "string", format: "date" } };
    expect(one({ op: "<", args: [p("a"), p("b")] }, { a: "2020-01-02", b: "2020-01-10" }, dates)).toBe(true);
    expect(one({ op: "<", args: [p("a"), p("b")] }, { a: "2020-01-02", b: "2020-1-10" }, dates)).toBe(null);
  });

  it("without queryables, values of two types are NULL (a type mismatch), never converted", () => {
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a: "10", b: 10 })).toBe(null);
    expect(one({ op: "<", args: [p("a"), p("b")] }, { a: true, b: 1 })).toBe(null);
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a: 1, b: 1 })).toBe(true);
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a: new Date(a), b: new Date(b) })).toBe(true);
  });

  it("a NULL or missing side is NULL", () => {
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a: 1, b: null })).toBe(null);
    expect(one({ op: "<>", args: [p("a"), p("b")] }, { a: 1 })).toBe(null);
    expect(one({ op: "=", args: [p("a"), p("a")] }, {})).toBe(null);
  });

  it("each side is folded by its own CASEI / ACCENTI, as written", () => {
    expect(one({ op: "=", args: [casei(p("a")), casei(p("b"))] }, { a: "Straße", b: "STRASSE" })).toBe(true);
    expect(one({ op: "=", args: [casei(p("a")), p("b")] }, { a: "Straße", b: "STRASSE" })).toBe(false);
    expect(one({ op: "=", args: [casei(p("a")), p("b")] }, { a: "Straße", b: "strasse" })).toBe(true);
    expect(one({ op: "=", args: [p("a"), p("b")] }, { a: "café", b: "café" })).toBe(true); // NFC
  });

  it("BETWEEN with property bounds is x >= low AND x <= high: a NULL bound gives FALSE or NULL, as in SQL", () => {
    const between = { op: "between", args: [p("x"), p("low"), p("high")] };
    expect(one(between, { x: 5, low: 1, high: 9 })).toBe(true);
    expect(one(between, { x: 5, low: null, high: 3 })).toBe(false);
    expect(one(between, { x: 5, low: null, high: 9 })).toBe(null);
    expect(one(between, { x: 5, low: 6, high: null })).toBe(false);
    expect(one({ op: "between", args: [5, p("low"), 9] }, { low: 1 })).toBe(true);
    expect(one({ op: "between", args: [5, 1, 9] }, {})).toBe(true);
  });

  it("IN with property items is the OR of the equalities", () => {
    const inList = { op: "in", args: [p("x"), [p("a"), 3]] };
    expect(one(inList, { x: 5, a: 5 })).toBe(true); // cql2-rs 0.5.6 answers false
    expect(one(inList, { x: 3, a: null })).toBe(true);
    expect(one(inList, { x: 4, a: null })).toBe(null);
    expect(one(inList, { x: 4, a: 7 })).toBe(false);
    expect(one({ op: "in", args: ["b", [p("a"), "b"]] }, {})).toBe(true);
  });

  it("NaN (only getProperty can give one) is equal to itself and greater than every other number, from either side", () => {
    const n = { x: Number.NaN, y: Number.NaN, five: 5, inf: Infinity };
    expect(one({ op: ">", args: [p("x"), 5] }, n)).toBe(true); // as in 1.0
    expect(one({ op: "<", args: [5, p("x")] }, n)).toBe(true);
    expect(one({ op: "<", args: [p("five"), p("x")] }, n)).toBe(true);
    expect(one({ op: ">", args: [p("x"), p("inf")] }, n)).toBe(true);
    expect(one({ op: "=", args: [p("x"), p("y")] }, n)).toBe(true);
    expect(one({ op: "<>", args: [p("x"), p("x")] }, n)).toBe(false);
    expect(one({ op: "between", args: [p("x"), 0, p("y")] }, n)).toBe(true);
    expect(one({ op: "in", args: [p("x"), [1, p("y")]] }, n)).toBe(true);
  });

  it("two literals are decided once, whatever the feature", () => {
    expect(one({ op: "<", args: ["a", "b"] }, {})).toBe(true);
    expect(one({ op: "=", args: [{ date: "2020-01-01" }, { date: "2020-01-01" }] }, {})).toBe(true);
    expect(one({ op: "like", args: [casei("STRASSE"), casei("str%")] }, {})).toBe(true);
  });
});

// --- validate ------------------------------------------------------------------------------------------------------

const problems = (filter: unknown, queryables?: Readonly<Record<string, object>>) => {
  const result = validate(filter, queryables ? { queryables } : {});
  return result.valid ? [] : result.problems.map((x) => [x.code, x.path]);
};

describe("validate: the types of the two sides", () => {
  const Q = { s: { type: "string" }, t: { type: "string" }, n: { type: "integer" }, m: { type: "number" },
    day: { type: "string", format: "date" }, at: { type: "string", format: "date-time" }, g: { format: "geometry-any" }, any: {} };

  it("two properties of one kind, or of an unknown kind, compare", () => {
    for (const [x, y] of [["s", "t"], ["n", "m"], ["day", "day"], ["at", "at"], ["s", "any"], ["any", "n"]]) {
      expect(problems({ op: "=", args: [p(x!), p(y!)] }, Q), `${x} = ${y}`).toEqual([]);
    }
    expect(problems({ op: "=", args: [casei(p("s")), casei(p("t"))] }, Q)).toEqual([]);
  });

  it("two properties of different kinds, or that can't be compared at all, are a type mismatch", () => {
    for (const [x, y] of [["s", "n"], ["day", "at"], ["at", "s"], ["g", "g"]]) {
      expect(problems({ op: "<", args: [p(x!), p(y!)] }, Q), `${x} < ${y}`).toEqual([["type-mismatch", "/args/1"]]);
    }
    expect(problems({ op: "=", args: [casei(p("s")), p("n")] }, Q)).toEqual([["type-mismatch", "/args/1"]]);
  });

  it("a literal on the left is checked against the property on the right, at the literal", () => {
    expect(problems({ op: "=", args: [1, p("s")] }, Q)).toEqual([["type-mismatch", "/args/0"]]);
    expect(problems({ op: "=", args: [{ date: "2020-01-01" }, p("day")] }, Q)).toEqual([]);
  });

  it("two literals must be of one type", () => {
    expect(problems({ op: "=", args: ["a", 1] })).toEqual([["type-mismatch", "/args/1"]]);
    expect(problems({ op: "=", args: [casei("a"), 1] })).toEqual([["type-mismatch", "/args/1"]]);
    expect(problems({ op: "=", args: [casei("a"), "b"] })).toEqual([]);
  });

  it("BETWEEN: numbers or number properties in each place", () => {
    expect(problems({ op: "between", args: [p("n"), p("m"), 5] }, Q)).toEqual([]);
    expect(problems({ op: "between", args: [1, p("s"), 5] }, Q)).toEqual([["type-mismatch", "/args/1"]]);
    expect(problems({ op: "between", args: [1, "a", 5] })).toEqual([["type-mismatch", "/args/1"]]);
  });

  it("IN: each property item against the left side; the literals of one type, as before", () => {
    expect(problems({ op: "in", args: [p("n"), [p("m"), 3]] }, Q)).toEqual([]);
    expect(problems({ op: "in", args: [p("n"), [p("s"), 3]] }, Q)).toEqual([["type-mismatch", "/args/1/0"]]);
    expect(problems({ op: "in", args: [3, [p("n"), 4]] }, Q)).toEqual([]);
    expect(problems({ op: "in", args: [p("n"), [p("m"), 3, "x"]] }, Q)).toEqual([["mixed-list", "/args/1"]]);
  });

  it("LIKE: a string literal on the left; the pattern is never a property (the grammar's patternExpression)", () => {
    expect(problems({ op: "like", args: ["København", "K_benhavn"] })).toEqual([]);
    expect(problems({ op: "like", args: [5, "5%"] })).toEqual([["type-mismatch", "/args/0"]]);
    expect(problems({ op: "like", args: [p("s"), p("t")] })).toEqual([["wrong-arguments", "/args/1"]]);
    expect(problems({ op: "like", args: [p("s"), casei(p("t"))] })).toEqual([["wrong-arguments", "/args/1"]]);
  });
});

describe("the class: named when used, refused where not evaluated yet", () => {
  it("requiredConformance names it for a literal on the left or a property on the right, and only then", () => {
    const uses = (f: unknown) => requiredConformance(assertValid(f)).includes(CONFORMANCE.propertyProperty);
    for (const f of [
      { op: "=", args: [1, p("a")] }, { op: "=", args: [p("a"), p("b")] }, { op: "=", args: [casei(p("a")), casei(p("b"))] },
      { op: "like", args: ["a", "a%"] }, { op: "between", args: [p("x"), p("a"), 1] }, { op: "between", args: [1, 0, 2] },
      { op: "in", args: [p("x"), [p("a")]] }, { op: "in", args: [1, [1, 2]] }, { op: "=", args: [1, 1] },
    ]) expect(uses(f), JSON.stringify(f)).toBe(true);
    for (const f of [
      { op: "=", args: [p("a"), 1] }, { op: "=", args: [casei(p("a")), casei("b")] }, { op: "like", args: [p("a"), "a%"] },
      { op: "between", args: [p("x"), 0, 1] }, { op: "in", args: [p("x"), [1, 2]] },
    ]) expect(uses(f), JSON.stringify(f)).toBe(false);
  });

  it("CQL2-text writes and reads every shape", () => {
    for (const f of [
      { op: "=", args: [1, p("a")] }, { op: "<", args: [p("a"), p("b")] }, { op: "=", args: [casei(p("a")), casei(p("b"))] },
      { op: "like", args: [casei("STRASSE"), casei("str%")] }, { op: "between", args: [p("x"), p("a"), 1] },
      { op: "in", args: [p("x"), [p("a"), 3]] }, { op: "=", args: [true, true] },
      { op: ">=", args: [{ timestamp: "2020-01-01T00:00:00Z" }, p("t")] }, { op: "<>", args: [{ date: "2020-01-01" }, p("d")] },
    ] as Cql2Filter[]) expect(fromText(toText(f)), toText(f)).toEqual(f);
  });
});

// --- Spatial: a literal first, two geometry properties, two literals ----------------------------------------------

describe("evaluate: spatial relations with a literal first, two properties, or two literals", () => {
  const values = ALL.map(asGeoJson);
  const features = values.map((geometry, i) => ({ type: "Feature", id: i + 1, properties: {}, geometry }));
  const ids = (filter: unknown) => features.filter(toPredicate(filter as Cql2Filter, { spatialEngine: geosEngine })).map((f) => f.id);

  it(`the literal first selects what the property first selects, the relation its converse: ${FILTERS.length + RELATION_FILTERS.length} filters`, () => {
    for (const f of [...FILTERS, ...RELATION_FILTERS]) expect(ids(literalFirst(f)), JSON.stringify(f)).toEqual(ids(f));
  });

  it(`two literals: decided as the first literal, as a feature's geometry, against the second: ${LITERAL_PAIRS.length} filters`, () => {
    // A box as GeoJSON: a polygon, across the antimeridian two; heights left out, as the relations ignore them.
    const asGeometry = (l: { bbox?: number[] }) => {
      if (!l.bbox) return l;
      const b = l.bbox.length === 4 ? l.bbox : [l.bbox[0]!, l.bbox[1]!, l.bbox[3]!, l.bbox[4]!];
      const ring = (w: number, e: number) => [[w, b[1]], [e, b[1]], [e, b[3]], [w, b[3]], [w, b[1]]];
      return b[0]! > b[2]! ? { type: "MultiPolygon", coordinates: [[ring(b[0]!, 180)], [ring(-180, b[2]!)]] } : { type: "Polygon", coordinates: [ring(b[0]!, b[2]!)] };
    };
    for (const f of LITERAL_PAIRS as unknown as { op: string; args: [{ bbox?: number[] }, unknown] }[]) {
      const feature = { type: "Feature", properties: {}, geometry: asGeometry(f.args[0]) };
      const asProperty = toEvaluator({ op: f.op, args: [p("geometry"), f.args[1]] } as Cql2Filter, { spatialEngine: geosEngine })(feature);
      expect(toEvaluator(f as unknown as Cql2Filter, { spatialEngine: geosEngine })(undefined), JSON.stringify(f)).toBe(asProperty);
    }
  });

  const pairs = pairsOf(values);
  const pairFeatures = pairs.map(([a, b], i) => ({ type: "Feature", id: i + 1, properties: { other: b }, geometry: a }));
  const pairTruths = (filter: unknown) => pairFeatures.map(toEvaluator(filter as Cql2Filter, { spatialEngine: geosEngine }));

  it(`two properties, S_INTERSECTS: the package's own engine agrees with GEOS's matrix on every pair of geometries (${pairs.length} pairs)`, () => {
    const truths = pairTruths({ op: "s_intersects", args: [p("geometry"), p("other")] });
    pairs.forEach(([a, b], i) => {
      const geometry = (g: unknown) => typeof g === "object" && g !== null && (g as { type?: unknown }).type !== undefined;
      if (!geometry(a) || !geometry(b)) return expect(truths[i], JSON.stringify([a, b])).toBe(null); // NULL, or not a geometry
      const empty = (g: { coordinates?: unknown[]; geometries?: unknown[] }) => (g.coordinates ?? g.geometries)!.length === 0;
      if (empty(a as never) || empty(b as never)) return expect(truths[i]).toBe(false);
      const matrix = geosEngine.prepare(a as never).relate(b as never);
      expect(truths[i], JSON.stringify([a, b])).toBe(!/^FF.FF....$/.test(matrix));
    });
  });

  it("two properties: each relation is its converse the other way round; NULL for a value that isn't a geometry, FALSE for an empty one", () => {
    for (const op of ["s_intersects", "s_disjoint", "s_equals", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"]) {
      const converse = op === "s_within" ? "s_contains" : op === "s_contains" ? "s_within" : op;
      expect(pairTruths({ op, args: [p("geometry"), p("other")] }), op).toEqual(pairTruths({ op: converse, args: [p("other"), p("geometry")] }));
    }
    const one = (a: unknown, b: unknown, op = "s_within") =>
      toEvaluator({ op, args: [p("geometry"), p("other")] } as Cql2Filter, { spatialEngine: geosEngine })({ type: "Feature", properties: { other: b }, geometry: a });
    const point = { type: "Point", coordinates: [1, 1] };
    expect(one(point, "not a geometry")).toBe(null);
    expect(one(point, null)).toBe(null);
    expect(one({ type: "Point", coordinates: [] }, point)).toBe(false);
    expect(one({ type: "Point", coordinates: [] }, { type: "Point", coordinates: [] }, "s_equals")).toBe(false);
    expect(one(point, point, "s_equals")).toBe(true);
  });

  it("validate: the class is named; S_INTERSECTS of two properties is Basic Spatial Functions; CQL2-text reads every shape back", () => {
    const uses = (f: unknown) => requiredConformance(assertValid(f));
    expect(uses({ op: "s_intersects", args: [p("a"), p("b")] })).toEqual([CONFORMANCE.basic, CONFORMANCE.basicSpatial, CONFORMANCE.propertyProperty]);
    expect(uses({ op: "s_intersects", args: [{ type: "LineString", coordinates: [[0, 0], [1, 1]] }, p("b")] })).toContain(CONFORMANCE.basicSpatialPlus);
    expect(uses({ op: "s_within", args: [{ bbox: [0, 0, 1, 1] }, p("b")] })).toEqual([CONFORMANCE.basic, CONFORMANCE.spatial, CONFORMANCE.propertyProperty]);
    expect(problems({ op: "s_within", args: [p("g"), p("n")] }, { g: { format: "geometry-any" }, n: { type: "integer" } })).toEqual([["type-mismatch", "/args/1"]]);
    for (const f of [...LITERAL_PAIRS, ...PAIR_FILTERS, ...LITERAL_FIRST.slice(0, 40)]) expect(fromText(toText(f))).toEqual(f);
  });
});
