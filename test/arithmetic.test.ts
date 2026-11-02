/**
 * Arithmetic Expressions (OGC 21-065r2 §7.12, Requirement 19): the standard's own tests (Annex A.14: Table 17's
 * counts on its test data, Conformance Test 53; the combinations of test 54), then what the standard leaves to the
 * package (doubles, `div` and `%`, results that aren't finite numbers), the classes, and CQL2-text.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { toEvaluator, toPredicate, type Truth } from "ogc-cql2/evaluate";
import { fromText } from "ogc-cql2/parse";
import { sqliteFunctions, toSql } from "ogc-cql2/sql";
import { toText } from "ogc-cql2/text";
import { assertValid, requiredConformance, validate } from "ogc-cql2/validate";
import { PLACES_QUERYABLES, places, sqlLiteral, TABLE_17 } from "./table16.ts";

const p = (property: string) => ({ property });
/** An expression `a o b`, typed loosely: the tests build filters the types allow and some they don't. */
const op = (o: string, a: unknown, b: unknown): never => ({ op: o, args: [a, b] }) as never;
/** The right side of a comparison read from CQL2-text. */
const rhs = (text: string): unknown => (fromText(text) as unknown as { args: unknown[] }).args[1];

describe("the standard's Table 17 (Conformance Test 53), on its test data", () => {
  it.for(TABLE_17)("%s: %i", ([text, expected]) => {
    const filter = fromText(text);
    expect(places.filter(toPredicate(filter)).length).toBe(expected);
    expect(requiredConformance(filter)).toContain(CONFORMANCE.arithmetic);
    expect(fromText(toText(filter))).toEqual(filter);
  });

  it("Conformance Test 54: ((NOT p1 AND p2) OR (p3 AND NOT p4) OR NOT (p1 AND p4)) is the Kleene combination of its parts", () => {
    const predicates = TABLE_17.map(([text]) => fromText(text));
    const and = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === true && b === true ? true : null);
    const or = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === false && b === false ? false : null);
    const not = (a: Truth): Truth => (a === null ? null : !a);
    const results = (f: unknown) => places.map(toEvaluator(f as Cql2Filter));
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % predicates.length;
    for (let n = 0; n < 20; n++) {
      const [p1, p2, p3, p4] = [next(), next(), next(), next()].map((i) => predicates[i]!);
      const [r1, r2, r3, r4] = [p1, p2, p3, p4].map(results);
      const combined = {
        op: "or", args: [{ op: "and", args: [{ op: "not", args: [p1] }, p2] }, { op: "and", args: [p3, { op: "not", args: [p4] }] },
          { op: "not", args: [{ op: "and", args: [p1, p4] }] }],
      };
      expect(results(combined)).toEqual(places.map((_, i) => or(or(and(not(r1![i]!), r2![i]!), and(r3![i]!, not(r4![i]!))), not(and(r1![i]!, r4![i]!)))));
    }
  });
});

describe("Table 17 in SQLite, typed as GeoPackage types it", () => {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);
  const names = Object.keys(PLACES_QUERYABLES);
  db.exec(`CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, nameascii TEXT, pop_min INTEGER, pop_max INTEGER,
           pop_other INTEGER, start DATETIME, "end" DATETIME)`);
  db.exec(`INSERT INTO places VALUES ${places.map((f) => `(${[f.id, ...names.map((n) => f.properties[n])].map(sqlLiteral).join(", ")})`).join(", ")}`);

  it.for(TABLE_17)("%s: %i", ([text, expected]) => {
    const { where, params } = toSql(fromText(text), { dialect: "sqlite", columns: PLACES_QUERYABLES });
    expect((db.prepare(`SELECT count(*) AS n FROM places WHERE ${where}`).get(...(params as never[])) as { n: number }).n).toBe(expected);
  });
});

// --- What the standard leaves to the package --------------------------------------------------------------------

/** `x = expression` on one feature: TRUE when the expression gives exactly `x`, NULL when it is NULL. */
const equals = (expression: unknown, x: unknown, properties: Record<string, unknown> = {}): Truth =>
  toEvaluator({ op: "=", args: [p("x"), expression] } as Cql2Filter)({ properties: { x, ...properties } });

describe("evaluate: doubles, div and %, and results that aren't finite", () => {
  it("numbers are doubles: 5 / 2 is 2.5, also for integers", () => {
    expect(equals(op("/", 5, 2), 2.5)).toBe(true);
    expect(equals(op("/", p("n"), 2), 2.5, { n: 5 })).toBe(true);
    expect(equals(op("+", 0.1, 0.2), 0.30000000000000004)).toBe(true);
    expect(equals(op("+", 9007199254740992, 1), 9007199254740992)).toBe(true); // 2^53 + 1 isn't a double
  });

  it("div rounds toward zero; % is its remainder x − y × trunc(x / y)", () => {
    for (const [a, b, q, r] of [[7, 2, 3, 1], [-7, 2, -3, -1], [7, -2, -3, 1], [7.5, 2, 3, 1.5], [-7.5, 2, -3, -1.5]] as const) {
      expect(equals(op("div", a, b), q), `${a} div ${b}`).toBe(true);
      expect(equals(op("%", a, b), r), `${a} % ${b}`).toBe(true);
    }
    expect(equals(op("%", 0.3, 0.1), 0.3 - 0.1 * 2)).toBe(true); // 0.09999999999999998, as 0.3 % 0.1 in JavaScript
  });

  it("^ is the power; precedence as the grammar reads it", () => {
    expect(equals(op("^", 2, -1), 0.5)).toBe(true);
    expect(equals(rhs("x = 2 + 3 * 4 ^ 2"), 50)).toBe(true);
    expect(equals(rhs("x = 2 - 3 - 4"), -5)).toBe(true); // left to right
    expect(equals(rhs("x = 2 ^ 3 * 2"), 16)).toBe(true);
  });

  it("a result that isn't a finite number is NULL: division by zero, 0 ^ −1, (−8) ^ 0.5, overflow", () => {
    for (const expression of [op("/", 1, 0), op("div", 1, 0), op("%", 1, 0), op("/", 0, 0), op("^", 0, -1), op("^", -8, 0.5),
      op("*", 1e308, 10), op("^", 10, 400)]) {
      expect(equals(expression, 1), JSON.stringify(expression)).toBe(null);
      expect(toEvaluator({ op: "not", args: [{ op: "=", args: [p("x"), expression] }] } as Cql2Filter)({ properties: { x: 1 } })).toBe(null);
    }
  });

  it("an operand that is NULL, missing, or not a number makes it NULL: values are never converted", () => {
    expect(equals(op("+", p("n"), 1), 2, { n: null })).toBe(null);
    expect(equals(op("+", p("n"), 1), 2, {})).toBe(null);
    expect(equals(op("+", p("n"), 1), 6, { n: "5" })).toBe(null);
    expect(equals(op("+", p("n"), 1), 2, { n: true })).toBe(null);
    expect(equals(op("+", p("n"), 1), Infinity, { n: Infinity })).toBe(null);
    expect(equals(op("*", p("n"), 0), 0, { n: Number.NaN })).toBe(null);
  });

  it("scaling: area > population * 0.001, BETWEEN and IN with expressions", () => {
    const scaled = { op: ">", args: [p("area"), op("*", p("population"), 0.001)] } as Cql2Filter;
    expect(toEvaluator(scaled)({ properties: { area: 100, population: 50000 } })).toBe(true);
    expect(toEvaluator(scaled)({ properties: { area: 10, population: 50000 } })).toBe(false);
    const between = { op: "between", args: [op("/", p("a"), 2), op("-", p("b"), 1), 10] } as Cql2Filter;
    expect(toEvaluator(between)({ properties: { a: 10, b: 3 } })).toBe(true);
    expect(toEvaluator({ op: "in", args: [op("+", p("a"), 1), [4, op("*", p("b"), 2)]] } as Cql2Filter)({ properties: { a: 5, b: 3 } })).toBe(true);
  });
});

// --- validate, the classes, CQL2-text ---------------------------------------------------------------------------

const problems = (filter: unknown, queryables?: Readonly<Record<string, object>>) => {
  const result = validate(filter, queryables ? { queryables } : {});
  return result.valid ? [] : result.problems.map((x) => [x.code, x.path]);
};

describe("validate: arithmetic works on numbers", () => {
  const Q = { n: { type: "integer" }, m: { type: "number" }, s: { type: "string" }, d: { type: "string", format: "date" }, any: {} };

  it("numbers, number properties, and expressions of them", () => {
    expect(problems({ op: ">", args: [p("n"), op("*", p("m"), op("+", 1, p("any")))] }, Q)).toEqual([]);
  });

  it("a string, a date or a string property in it is a type mismatch; so is comparing it with a string", () => {
    expect(problems({ op: ">", args: [p("n"), op("+", p("s"), 1)] }, Q)).toEqual([["type-mismatch", "/args/1/args/0"]]);
    expect(problems({ op: ">", args: [p("n"), op("+", "5", 1)] })).toEqual([["type-mismatch", "/args/1/args/0"]]);
    expect(problems({ op: ">", args: [p("n"), op("+", { date: "2020-01-01" }, 1)] })).toEqual([["type-mismatch", "/args/1/args/0"]]);
    expect(problems({ op: "=", args: [p("s"), op("+", 1, 2)] }, Q)).toEqual([["type-mismatch", "/args/1"]]);
    expect(problems({ op: "like", args: [op("+", 1, 2), "1%"] })).toEqual([["type-mismatch", "/args/0"]]);
    expect(problems({ op: ">", args: [p("n"), { op: "+", args: [1] }] })).toEqual([["wrong-arguments", "/args/1/args"]]);
  });

  it("the classes: Arithmetic Expressions; with an expression on the left, or a property on the right inside one, Property-Property too", () => {
    const uses = (f: unknown) => requiredConformance(assertValid(f));
    expect(uses({ op: ">", args: [p("n"), op("+", 1, 2)] })).toEqual([CONFORMANCE.basic, CONFORMANCE.arithmetic]);
    expect(uses({ op: ">", args: [p("area"), op("*", p("population"), 0.001)] })).toEqual([CONFORMANCE.basic, CONFORMANCE.propertyProperty, CONFORMANCE.arithmetic]);
    expect(uses({ op: ">", args: [op("/", p("area"), p("population")), 0.001] })).toContain(CONFORMANCE.propertyProperty);
    expect(uses({ op: "=", args: [op("+", 1038280, 8), p("pop_other")] })).toContain(CONFORMANCE.propertyProperty);
    const without = Object.values(CONFORMANCE).filter((c) => c !== CONFORMANCE.arithmetic);
    const refused = validate({ op: ">", args: [p("n"), op("+", 1, 2)] }, { conformance: without });
    expect(refused.valid ? [] : refused.problems.map((x) => [x.code, x.conformance])).toEqual([["needs-conformance", CONFORMANCE.arithmetic]]);
  });
});

describe("CQL2-text", () => {
  it("parentheses only where the grammar's precedence needs them", () => {
    const text = (e: unknown) => toText({ op: "=", args: [p("x"), e] } as Cql2Filter);
    expect(text(op("+", op("*", 2, 3), 4))).toBe("x = 2 * 3 + 4");
    expect(text(op("*", op("+", 2, 3), 4))).toBe("x = (2 + 3) * 4");
    expect(text(op("-", 2, op("-", 3, 4)))).toBe("x = 2 - (3 - 4)");
    expect(text(op("-", op("-", 2, 3), 4))).toBe("x = 2 - 3 - 4");
    expect(text(op("^", op("^", 2, 3), 2))).toBe("x = (2 ^ 3) ^ 2");
    expect(text(op("div", 7, 2))).toBe("x = 7 div 2");
  });

  it("random expressions read back as written (500 trees)", () => {
    const ops = ["+", "-", "*", "/", "%", "div", "^"];
    let seed = 3;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    const tree = (depth: number): unknown =>
      depth === 0 || rnd(3) === 0 ? (rnd(2) ? p(`a${rnd(3)}`) : rnd(20) - 5) : op(ops[rnd(ops.length)]!, tree(depth - 1), tree(depth - 1));
    for (let i = 0; i < 500; i++) {
      const filter = { op: "<", args: [p("x"), tree(4)] } as Cql2Filter;
      expect(fromText(toText(filter)), toText(filter)).toEqual(filter);
    }
  });
});
