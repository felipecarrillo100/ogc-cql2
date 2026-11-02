/**
 * Temporal Functions (OGC 21-065r2 §7.11): the standard's two tests on its test data, OWL-Time's relations, what the
 * standard leaves open (decided as the README says), validate's errors and classes, and the text round trip.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { evaluate, toEvaluator, toPredicate, type Truth } from "ogc-cql2/evaluate";
import { fromText } from "ogc-cql2/parse";
import { sqliteFunctions, toSql } from "ogc-cql2/sql";
import { toText } from "ogc-cql2/text";
import { requiredConformance, validate } from "ogc-cql2/validate";
import { generateTemporalFilters, p } from "./corpus.ts";
import { PLACES_QUERYABLES, places, sqlLiteral, TABLE_16_TEMPORAL, TABLE_TEMPORAL } from "./table16.ts";

const t = (op: string, a: unknown, b: unknown) => ({ op, args: [a, b] }) as Cql2Filter;
const iv = (a: unknown, b: unknown) => ({ interval: [a, b] });
const ts = (timestamp: string) => ({ timestamp });
const day = (date: string) => ({ date });
const feature = (properties: Record<string, unknown>) => ({ properties });
const codes = (x: unknown, options = {}) => {
  const result = validate(x, options);
  return result.valid ? [] : result.problems.map((problem) => `${problem.code} ${problem.path}`);
};

describe("the standard's tests on its test data: 72 predicates", () => {
  const rows = [...TABLE_TEMPORAL.map((r) => [...r, "test-data"] as const), ...TABLE_16_TEMPORAL.map((r) => [...r, "Table 16"] as const)];
  it("are all there", () => expect([TABLE_TEMPORAL.length, TABLE_16_TEMPORAL.length]).toEqual([36, 36]));

  it.for(rows)("%s gives %i (%s), with and without queryables", ([text, expected]) => {
    expect(places.filter(toPredicate(fromText(text, { queryables: PLACES_QUERYABLES }), { queryables: PLACES_QUERYABLES })).length).toBe(expected);
    expect(places.filter(toPredicate(fromText(text))).length).toBe(expected);
  });

  it("Table 16's rows need Property-Property Comparisons, the test-data rows don't", () => {
    for (const [text] of TABLE_TEMPORAL) expect(requiredConformance(fromText(text))).toEqual([CONFORMANCE.basic, CONFORMANCE.temporal]);
    for (const [text] of TABLE_16_TEMPORAL) {
      expect(requiredConformance(fromText(text))).toEqual([CONFORMANCE.basic, CONFORMANCE.propertyProperty, CONFORMANCE.temporal]);
    }
  });

  // Annex A, "logical": combinations of four of the predicates, `((NOT p1 AND p2) OR (p3 AND NOT p4)) OR NOT (p1 AND p4)`.
  it("combined with AND, OR and NOT, each place gives the three-valued combination of its results", () => {
    const filters = rows.map(([text]) => fromText(text));
    const results = (f: Cql2Filter) => places.map(toEvaluator(f));
    const and = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a && b ? true : null);
    const or = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === false && b === false ? false : null);
    const not = (a: Truth): Truth => (a === null ? null : !a);
    for (let k = 0; k < 40; k++) {
      const [f1, f2, f3, f4] = [0, 1, 2, 3].map((j) => filters[(k * 17 + j * 29) % filters.length]!);
      const [r1, r2, r3, r4] = [f1!, f2!, f3!, f4!].map(results);
      const filter = {
        op: "or",
        args: [
          { op: "or", args: [{ op: "and", args: [{ op: "not", args: [f1] }, f2] }, { op: "and", args: [f3, { op: "not", args: [f4] }] }] },
          { op: "not", args: [{ op: "and", args: [f1, f4] }] },
        ],
      } as Cql2Filter;
      expect(results(filter)).toEqual(places.map((_, i) => or(or(and(not(r1![i]!), r2![i]!), and(r3![i]!, not(r4![i]!))), not(and(r1![i]!, r4![i]!)))));
    }
  });
});

describe("the 72 predicates in SQLite, typed as GeoPackage types it (TEXT, INTEGER, DATETIME, DATE)", () => {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);
  const names = Object.keys(PLACES_QUERYABLES);
  db.exec(`CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, nameascii TEXT, pop_min INTEGER, pop_max INTEGER,
           pop_other INTEGER, start DATETIME, "end" DATETIME, "date" DATE)`);
  db.exec(`INSERT INTO places VALUES ${places.map((f) => `(${[f.id, ...names.map((n) => f.properties[n])].map(sqlLiteral).join(", ")})`).join(", ")}`);

  it.for([...TABLE_TEMPORAL, ...TABLE_16_TEMPORAL])("%s: %i", ([text, expected]) => {
    const { where, params } = toSql(fromText(text), { dialect: "sqlite", columns: PLACES_QUERYABLES });
    expect((db.prepare(`SELECT count(*) AS n FROM places WHERE ${where}`).get(...(params as never[])) as { n: number }).n).toBe(expected);
  });
});

describe("OWL-Time's relations", () => {
  const ALLEN = [
    "t_before", "t_after", "t_meets", "t_metBy", "t_overlaps", "t_overlappedBy", "t_starts", "t_startedBy", "t_during",
    "t_contains", "t_finishes", "t_finishedBy", "t_equals",
  ];
  /** Which of Allen's 13 relations two proper intervals are in, decided by where the four ends fall, apart from the formulas. */
  function allen([b1, e1]: number[], [b2, e2]: number[]): string {
    const cmp = (x: number, y: number) => Math.sign(x - y);
    const key = [cmp(b1!, b2!), cmp(b1!, e2!), cmp(e1!, b2!), cmp(e1!, e2!)].join(",");
    const table: Record<string, string> = {
      "-1,-1,-1,-1": "t_before", "1,1,1,1": "t_after", "-1,-1,0,-1": "t_meets", "1,0,1,1": "t_metBy",
      "-1,-1,1,-1": "t_overlaps", "1,-1,1,1": "t_overlappedBy", "0,-1,1,-1": "t_starts", "0,-1,1,1": "t_startedBy",
      "1,-1,1,-1": "t_during", "-1,-1,1,1": "t_contains", "1,-1,1,0": "t_finishes", "-1,-1,1,0": "t_finishedBy",
      "0,-1,1,0": "t_equals",
    };
    return table[key]!;
  }
  const at = (hour: number) => `2022-04-16T${String(hour).padStart(2, "0")}:00:00Z`;

  it("for two proper intervals, exactly one of Allen's thirteen holds, the one their ends say", () => {
    let seen = new Set<string>();
    for (let b1 = 0; b1 < 5; b1++) for (let e1 = b1 + 1; e1 < 6; e1++) for (let b2 = 0; b2 < 5; b2++) for (let e2 = b2 + 1; e2 < 6; e2++) {
      const f = feature({ b: at(b1), e: at(e1) });
      const other = iv(at(b2), at(e2));
      const holding = ALLEN.filter((op) => evaluate(t(op, iv(p("b"), p("e")), other), f) === true);
      expect(holding).toEqual([allen([b1, e1], [b2, e2])]);
      seen = seen.add(holding[0]!);
      // T_DISJOINT is T_BEFORE OR T_AFTER; T_INTERSECTS its negation.
      const disjoint = holding[0] === "t_before" || holding[0] === "t_after";
      expect(evaluate(t("t_disjoint", iv(p("b"), p("e")), other), f)).toBe(disjoint);
      expect(evaluate(t("t_intersects", iv(p("b"), p("e")), other), f)).toBe(!disjoint);
    }
    expect(seen.size).toBe(13);
  });

  it("an instant is the interval from it to itself: the five relations of instants", () => {
    const f = feature({ x: at(10) });
    expect(evaluate(t("t_equals", p("x"), ts(at(10))), f)).toBe(true);
    expect(evaluate(t("t_equals", p("x"), iv(at(10), at(10))), f)).toBe(true);
    expect(evaluate(t("t_intersects", p("x"), iv(at(10), at(12))), f)).toBe(true); // closed at both ends
    expect(evaluate(t("t_intersects", p("x"), iv(at(8), at(10))), f)).toBe(true);
    expect(evaluate(t("t_before", p("x"), iv(at(10), at(12))), f)).toBe(false);
    expect(evaluate(t("t_before", p("x"), ts(at(11))), f)).toBe(true);
    expect(evaluate(t("t_after", p("x"), iv(at(8), at(9))), f)).toBe(true);
    expect(evaluate(t("t_disjoint", p("x"), ts(at(11))), f)).toBe(true);
  });

  it("an interval of zero length can meet and start another: the relations are exclusive only for proper intervals", () => {
    const f = feature({ x: at(10) });
    expect(evaluate(t("t_meets", iv(p("x"), p("x")), iv(at(10), at(12))), f)).toBe(true);
    expect(evaluate(t("t_starts", iv(p("x"), p("x")), iv(at(10), at(12))), f)).toBe(true);
  });

  it("'..' is unbounded: −∞ as a start, +∞ as an end", () => {
    const f = feature({ x: at(10), y: at(12) });
    expect(evaluate(t("t_intersects", p("x"), iv("..", "..")), f)).toBe(true);
    expect(evaluate(t("t_during", iv(p("x"), p("y")), iv("..", "..")), f)).toBe(true);
    expect(evaluate(t("t_during", iv(p("x"), p("y")), iv("..", at(12))), f)).toBe(false); // ends together: finishes
    expect(evaluate(t("t_finishes", iv(p("x"), p("y")), iv("..", at(12))), f)).toBe(true);
    expect(evaluate(t("t_starts", iv(p("x"), ".."), iv(at(10), "..")), f)).toBe(false); // equal: both run on
    expect(evaluate(t("t_equals", iv(p("x"), ".."), iv(at(10), "..")), f)).toBe(true);
    expect(evaluate(t("t_before", iv("..", p("x")), iv(p("y"), "..")), f)).toBe(true);
    expect(evaluate(t("t_equals", iv("..", ".."), iv("..", "..")), f)).toBe(true); // literals only
  });

  it("dates compare as days, with intervals of days", () => {
    const f = feature({ d: "2022-04-16" });
    expect(evaluate(t("t_during", iv(p("d"), p("d")), iv("2022-01-01", "2022-12-31")), f)).toBe(true);
    expect(evaluate(t("t_meets", iv("2022-01-01", p("d")), iv(p("d"), "2022-12-31")), f)).toBe(true);
    expect(evaluate(t("t_after", p("d"), day("2022-04-15")), f)).toBe(true);
  });
});

describe("what the standard leaves open", () => {
  it("NULL: a NULL property, an interval with a NULL end, or one beginning after it ends (no interval), NOT included", () => {
    const filter = t("t_before", iv(p("s"), p("e")), iv("2030-01-01T00:00:00Z", ".."));
    expect(evaluate(filter, feature({ s: "2022-01-01T00:00:00Z", e: "2022-02-01T00:00:00Z" }))).toBe(true);
    for (const f of [feature({ s: null, e: "2022-02-01T00:00:00Z" }), feature({ s: "2022-01-01T00:00:00Z" }), feature({ s: "2022-03-01T00:00:00Z", e: "2022-02-01T00:00:00Z" })]) {
      expect(evaluate(filter, f)).toBe(null);
      expect(evaluate({ op: "not", args: [filter] }, f)).toBe(null);
      // A disjunction of ends: one end alone would decide it, but the predicate is NULL.
      expect(evaluate(t("t_disjoint", iv(p("s"), p("e")), iv("2022-02-15T00:00:00Z", "2022-02-20T00:00:00Z")), f)).toBe(null);
    }
    expect(evaluate(t("t_after", p("x"), ts("2022-01-01T00:00:00Z")), feature({}))).toBe(null);
    expect(evaluate(t("t_equals", iv("2022-03-01", "2022-02-01"), iv("2022-03-01", "2022-02-01")), feature({}))).toBe(null);
  });

  it("dates and timestamps are never converted: a value of the other kind is NULL", () => {
    expect(evaluate(t("t_after", p("x"), ts("2022-01-01T00:00:00Z")), feature({ x: "2022-04-16" }))).toBe(null);
    expect(evaluate(t("t_after", p("x"), day("2022-01-01")), feature({ x: "2022-04-16T00:00:00Z" }))).toBe(null);
    expect(evaluate(t("t_after", p("x"), day("2022-01-01")), feature({ x: "2022-04-16" }))).toBe(true);
    expect(evaluate(t("t_after", p("x"), ts("2022-01-01T00:00:00Z")), feature({ x: 1650000000000 }))).toBe(null);
    // Two properties, nothing saying: each value of its own kind, and the same for both.
    expect(evaluate(t("t_before", p("x"), p("y")), feature({ x: "2022-04-16", y: "2022-04-17" }))).toBe(true);
    expect(evaluate(t("t_before", p("x"), p("y")), feature({ x: "2022-04-16T00:00:00Z", y: "2022-04-17T00:00:00Z" }))).toBe(true);
    expect(evaluate(t("t_before", p("x"), p("y")), feature({ x: "2022-04-16", y: "2022-04-17T00:00:00Z" }))).toBe(null);
    expect(evaluate(t("t_before", p("x"), p("y")), feature({ x: "2022-04-16T00:00:00Z", y: "2022-04-17" }))).toBe(null);
    expect(evaluate(t("t_before", p("x"), p("y")), feature({ x: new Date("2022-04-16T00:00:00Z"), y: "2022-04-17" }))).toBe(null);
    // Queryables say: the values are read as they say.
    const queryables = { x: { type: "string", format: "date" }, y: { type: "string", format: "date-time" } };
    expect(evaluate(t("t_before", p("x"), p("x")), feature({ x: "2022-04-16T00:00:00Z" }), { queryables })).toBe(null);
    expect(evaluate(t("t_before", p("x"), p("y")), feature({ x: "2022-04-16", y: "2022-04-17T00:00:00Z" }), { queryables })).toBe(null);
  });

  it("instants at millisecond precision, a Date as an instant", () => {
    const f = feature({ x: "2022-04-16T10:15:10.0004Z", d: new Date("2022-04-16T10:15:10Z") });
    expect(evaluate(t("t_equals", p("x"), ts("2022-04-16T10:15:10Z")), f)).toBe(true);
    expect(evaluate(t("t_equals", p("d"), ts("2022-04-16T10:15:10.000999Z")), f)).toBe(true);
    expect(evaluate(t("t_equals", p("x"), ts("2022-04-16T12:15:10Z")), feature({ x: "2022-04-16T14:15:10+02:00" }))).toBe(true);
  });
});

describe("validate", () => {
  it("the relations of intervals only refuse an instant, the standard's client error; INTERVAL(x, x) is an interval", () => {
    expect(codes(t("t_during", p("x"), iv("2022-01-01", "2022-12-31")))).toEqual(["wrong-arguments /args/0"]);
    expect(codes(t("t_meets", iv(p("s"), p("e")), day("2022-01-01")))).toEqual(["wrong-arguments /args/1"]);
    expect(codes(t("t_during", iv(p("x"), p("x")), iv("2022-01-01", "2022-12-31")))).toEqual([]);
    for (const op of ["t_after", "t_before", "t_disjoint", "t_equals", "t_intersects"]) expect(codes(t(op, p("x"), day("2022-01-01")))).toEqual([]);
  });

  it("an interval's ends are both dates or both instants, and so are all the ends with queryables", () => {
    expect(codes(t("t_intersects", p("x"), iv("2022-01-01", "2022-04-11T12:41:13Z")))).toEqual(["type-mismatch /args/1/interval/1"]);
    expect(codes(t("t_intersects", iv("..", "2022-01-01"), day("2022-01-01")))).toEqual([]);
    expect(codes(t("t_intersects", iv("2022-01-01", ".."), ts("2022-01-01T00:00:00Z")))).toEqual(["type-mismatch /args/1"]);
    const queryables = { d: { type: "string", format: "date" }, i: { type: "string", format: "date-time" }, n: { type: "integer" } };
    expect(codes(t("t_after", p("d"), ts("2022-01-01T00:00:00Z")), { queryables })).toEqual(["type-mismatch /args/1"]);
    expect(codes(t("t_after", p("d"), p("i")), { queryables })).toEqual(["type-mismatch /args/1"]);
    expect(codes(t("t_after", iv(p("d"), p("i")), iv("..", "..")), { queryables })).toEqual(["type-mismatch /args/0/interval/1"]);
    expect(codes(t("t_after", p("n"), day("2022-01-01")), { queryables })).toEqual(["type-mismatch /args/0"]);
    expect(codes(t("t_after", p("d"), day("2022-01-01")), { queryables })).toEqual([]);
  });

  it("refuses what isn't an instant or an interval, and malformed intervals", () => {
    expect(codes(t("t_after", p("x"), "2022-01-01"))).toEqual(["type-mismatch /args/1"]);
    expect(codes(t("t_after", p("x"), 5))).toEqual(["type-mismatch /args/1"]);
    expect(codes(t("t_after", p("x"), { interval: ["2022-01-01"] }))).toEqual(["wrong-arguments /args/1/interval"]);
    expect(codes(t("t_after", p("x"), iv({ date: "2022-01-01" }, "..")))).toEqual(["wrong-arguments /args/1/interval/0"]);
    expect(codes(t("t_after", p("x"), iv("2022-02-30", "..")))).toEqual(["invalid-date /args/1/interval/0"]);
    expect(codes(t("t_after", p("x"), iv("..", "2022-01-01T24:00:00Z")))).toEqual(["invalid-timestamp /args/1/interval/1"]);
    expect(codes(t("t_after", p("x"), iv("..", { op: "now", args: [] })))).toEqual(["outside-profile /args/1/interval/1"]);
    expect(codes({ op: "t_after", args: [p("x")] })).toEqual(["wrong-arguments /args"]);
    expect(codes({ op: "=", args: [p("x"), iv("..", "..")] })).toEqual(["wrong-arguments /args/1"]);
  });

  it("the classes: Temporal Functions; a literal first or a property second also Property-Property", () => {
    const { basic, propertyProperty: pp, temporal } = CONFORMANCE;
    expect(requiredConformance(t("t_after", p("x"), day("2022-01-01")))).toEqual([basic, temporal]);
    expect(requiredConformance(t("t_after", iv(p("s"), p("e")), iv("..", "2022-01-01")))).toEqual([basic, temporal]);
    expect(requiredConformance(t("t_after", day("2022-01-01"), p("x")))).toEqual([basic, pp, temporal]);
    expect(requiredConformance(t("t_after", p("x"), p("y")))).toEqual([basic, pp, temporal]);
    expect(requiredConformance(t("t_after", p("x"), iv(p("s"), "..")))).toEqual([basic, pp, temporal]);
    expect(requiredConformance(t("t_after", iv("..", ".."), day("2022-01-01")))).toEqual([basic, pp, temporal]);
    expect(codes(t("t_after", p("x"), day("2022-01-01")), { conformance: [basic] })).toEqual(["needs-conformance "]);
    expect(codes(t("t_after", day("2022-01-01"), p("x")), { conformance: [basic, temporal] })).toEqual(["needs-conformance "]);
  });
});

describe("CQL2-text", () => {
  it("writes the functions in the grammar's capitals and intervals with their ends quoted", () => {
    expect(toText(t("t_finishedBy", iv(p("start"), p("end")), iv("2022-01-01T00:00:00Z", "..")))).toBe(
      `T_FINISHEDBY(INTERVAL(start, end), INTERVAL('2022-01-01T00:00:00Z', '..'))`,
    );
    expect(toText(t("t_after", p("date"), day("2022-01-01")))).toBe(`T_AFTER("date", DATE('2022-01-01'))`);
  });

  it("round trips the generated filters", () => {
    const filters = generateTemporalFilters(["a", "date", "start"]);
    expect(filters.length).toBeGreaterThan(1000);
    for (const filter of filters) expect(fromText(toText(filter))).toEqual(filter);
  });
});
