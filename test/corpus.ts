/**
 * The generated filters of the DuckDB differential test, for any property names: every operator of the profile with
 * awkward literals (Unicode in NFC and NFD, code points above U+FFFF, LIKE's special characters, numbers needing 17
 * digits, instants with fractions), under NOT, AND and OR. Also read back by the CQL2-text round trip.
 */
import type { Cql2Filter } from "ogc-cql2";
import { validate } from "ogc-cql2/validate";

export const p = (property: string) => ({ property });
export const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
export const accenti = (arg: unknown) => ({ op: "accenti", args: [arg] });
const LITERALS: unknown[] = [
  "Straße", "São Paulo", "SAO PAULO", "Sao Paulo", "año", "ano", "はじめ", "はしめ", "Łodz", "Lodz", "Ma\u0300", "STRASSE", "café", "cafe\u0301", "", "😀", "\uE000", "Riv", "river", "a_b", "Ελλάδα", "100%", "end\\",
  "2020-07-26", "2023-01-01T00:00:00.000Z", "2023-01-01T10:00:00.000", "2023-01-01T00:00:00.001Z",
  0, 1, 2.5, 5, 10, -1, 12.34, 9007199254740991, 0.9653517007827759, -174.71493244171143, 206289291381835.94, true, false,
  { date: "2020-07-26" }, { date: "2021-01-01" }, { date: "0099-07-26" },
  { timestamp: "2023-01-01T00:00:00Z" }, { timestamp: "2022-12-31T23:00:00Z" }, { timestamp: "2023-01-01T00:00:00.5Z" },
  { timestamp: "2023-01-01T00:00:00.001Z" }, { timestamp: "1969-12-31T23:59:59.999Z" },
];
const OPS = ["=", "<>", "<", "<=", ">", ">="];
const PATTERNS = ["S_o%", "%PAULO", "ano", "は%め", "%", "_%", "", "Stra%", "%ss%", "%SS%", "100\\%", "a\\_b", "a_b", "%é", "ri%", "Ri_", "_", "%😀%", "% %", "end\\", "%T%", "2023%", "%.001%"];

export function generateFilters(properties: readonly string[]): Cql2Filter[] {
  const leaves: unknown[] = [true, false];
  for (const name of properties) {
    leaves.push({ op: "isNull", args: [p(name)] });
    for (const value of LITERALS) for (const op of OPS) leaves.push({ op, args: [p(name), value] });
    for (const value of LITERALS.filter((v) => typeof v === "string")) {
      for (const op of ["=", "<"]) {
        leaves.push({ op, args: [accenti(p(name)), accenti(value)] });
        leaves.push({ op, args: [accenti(p(name)), value] }, { op, args: [p(name), accenti(value)] });
        leaves.push({ op, args: [casei(accenti(p(name))), casei(accenti(value))] });
        leaves.push({ op, args: [accenti(casei(p(name))), accenti(casei(value))] });
        leaves.push({ op, args: [casei(p(name)), casei(value)] });
        leaves.push({ op, args: [casei(p(name)), value] });
        leaves.push({ op, args: [p(name), casei(value)] });
      }
    }
    for (const pattern of PATTERNS) {
      leaves.push({ op: "like", args: [p(name), pattern] });
      leaves.push({ op: "like", args: [casei(p(name)), casei(pattern)] });
      leaves.push({ op: "like", args: [accenti(p(name)), accenti(pattern)] });
      leaves.push({ op: "like", args: [casei(accenti(p(name))), casei(accenti(pattern))] });
      leaves.push({ op: "like", args: [p(name), casei(pattern)] });
    }
    leaves.push({ op: "between", args: [p(name), 0, 5] }, { op: "between", args: [p(name), -1, 2.5] });
    for (const list of [["Straße", "café"], [5, 10], [true], [{ date: "2020-07-26" }, { date: "1999-12-31" }],
      [{ timestamp: "2023-01-01T00:00:00Z" }], [0, 1]]) {
      leaves.push({ op: "in", args: [p(name), list] });
    }
    leaves.push({ op: "in", args: [casei(p(name)), [casei("strasse"), casei("ελλάδα")]] });
    leaves.push({ op: "in", args: [accenti(p(name)), [accenti("Sao Paulo"), accenti("ano")]] });
  }
  const valid = leaves.filter((f) => validate(f).valid) as Cql2Filter[];
  const nots = valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter);
  const pairs: Cql2Filter[] = [];
  for (let i = 0; i + 1 < valid.length; i += 7) {
    pairs.push({ op: "and", args: [valid[i]!, valid[i + 1]!] }, { op: "or", args: [valid[i]!, valid[i + 1]!] });
    pairs.push({ op: "not", args: [{ op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] }] });
  }
  return [...valid, ...nots, ...pairs];
}

/**
 * Property-Property Comparisons for the same differential tests: every pair of the properties (plain, and under
 * CASEI / ACCENTI), the literals on the left, BETWEEN and IN with properties as bounds and items, two literals, and
 * the same under NOT, AND and OR. Only filters valid without queryables: a pair the table's types can't compare is
 * for the test to leave out (`toSql` refuses it).
 */
export function generatePropertyFilters(properties: readonly string[]): Cql2Filter[] {
  const leaves: unknown[] = [];
  const left = LITERALS.filter((_, i) => i % 3 === 0); // a third of the literals, on the left
  for (const a of properties) {
    for (const b of properties) {
      for (const op of OPS) leaves.push({ op, args: [p(a), p(b)] });
      for (const op of ["=", "<"]) {
        leaves.push({ op, args: [casei(p(a)), casei(p(b))] }, { op, args: [casei(p(a)), p(b)] });
        leaves.push({ op, args: [accenti(p(a)), accenti(p(b))] }, { op, args: [p(a), accenti(p(b))] });
        leaves.push({ op, args: [casei(accenti(p(a))), accenti(casei(p(b)))] });
      }
      leaves.push({ op: "between", args: [p(a), p(b), 10] }, { op: "between", args: [p(a), 0, p(b)] });
      leaves.push({ op: "between", args: [1, p(a), p(b)] }, { op: "in", args: [p(a), [p(b), 5]] });
      leaves.push({ op: "in", args: [p(a), [p(b), "Straße"]] }, { op: "in", args: [casei(p(a)), [casei(p(b)), casei("strasse")]] });
    }
    for (const value of left) for (const op of OPS) leaves.push({ op, args: [value, p(a)] });
    leaves.push({ op: "=", args: [casei("STRASSE"), casei(p(a))] }, { op: "<", args: [accenti("Sao"), accenti(p(a))] });
    leaves.push({ op: "in", args: ["Straße", [p(a), "x"]] }, { op: "in", args: [5, [p(a)]] });
  }
  leaves.push(
    { op: "=", args: [1, 1] }, { op: "<", args: ["a", "b"] }, { op: ">", args: [{ date: "2020-01-02" }, { date: "2020-01-01" }] },
    { op: "like", args: ["København", "K_benhavn"] }, { op: "like", args: [casei("STRASSE"), casei("str%")] },
    { op: "between", args: [5, 1, 9] }, { op: "in", args: [3, [1, 2]] },
  );
  const valid = leaves.filter((f) => validate(f).valid) as Cql2Filter[];
  const nots = valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter);
  const pairs: Cql2Filter[] = [];
  for (let i = 0; i + 1 < valid.length; i += 11) {
    pairs.push({ op: "and", args: [valid[i]!, valid[i + 1]!] }, { op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });
  }
  return [...valid, ...nots, ...pairs];
}

/**
 * Arithmetic Expressions for the same differential tests: each operator on a property and a literal, on two
 * properties, nested, and of literals alone, under every comparison, in BETWEEN and IN, and under NOT, AND and OR.
 * The literals reach zero divisors, fractions, signs, overflow (1e308) and underflow (1e-320). Powers only with whole
 * exponents 0–3, whose results are exact: a power that isn't exact may differ in the last bit between engines.
 */
export function generateArithmeticFilters(properties: readonly string[]): Cql2Filter[] {
  const ops = ["+", "-", "*", "/", "%", "div"];
  const values = [0, 1, -1, 2, 0.5, 3, 7.5, -2.5, 1e308, -1e308, 1e-320];
  const targets = [0, 1, 5, -1, 2.5, 10];
  const arith = (op: string, a: unknown, b: unknown) => ({ op, args: [a, b] });
  const leaves: unknown[] = [];
  for (const a of properties) {
    for (const op of ops) {
      for (const v of values) {
        leaves.push({ op: ">", args: [arith(op, p(a), v), targets[(values.indexOf(v) + ops.indexOf(op)) % targets.length]] });
        leaves.push({ op: "=", args: [arith(op, v, p(a)), targets[values.indexOf(v) % targets.length]] });
      }
    }
    for (const e of [0, 1, 2, 3]) leaves.push({ op: "<=", args: [arith("^", p(a), e), 25] }, { op: "=", args: [arith("^", p(a), e), 4] });
    for (const b of properties) {
      for (const op of ops) leaves.push({ op: "<", args: [arith(op, p(a), p(b)), 3] }, { op: ">=", args: [p(a), arith(op, p(b), 2)] });
      leaves.push({ op: ">", args: [p(a), arith("*", p(b), 0.001)] }); // scaling
      leaves.push({ op: "=", args: [arith("-", arith("*", p(a), 2), arith("div", p(b), 2)), 1] });
    }
    leaves.push({ op: "between", args: [arith("/", p(a), 2), -1, arith("+", 1, 2)] });
    leaves.push({ op: "in", args: [arith("%", p(a), 3), [0, 1, arith("-", 0, 1)]] });
    leaves.push({ op: "<", args: [p(a), arith("^", 2, 3)] }, { op: "=", args: [p(a), arith("/", 1, 0)] });
  }
  leaves.push({ op: "=", args: [arith("+", 1, 2), 3] }, { op: "<", args: [arith("/", 1, 0), 1] });
  const valid = leaves.filter((f) => validate(f).valid) as Cql2Filter[];
  const nots = valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter);
  const pairs: Cql2Filter[] = [];
  for (let i = 0; i + 1 < valid.length; i += 13) {
    pairs.push({ op: "and", args: [valid[i]!, valid[i + 1]!] }, { op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });
  }
  return [...valid, ...nots, ...pairs];
}

/**
 * Temporal filters on the given properties: every function, with instants and intervals of dates and of timestamps,
 * `'..'` at either end, a literal first, two properties, an interval of one property, and literals only; with NOT,
 * AND and OR. The literals sit on and around the awkward values' ends, so that equal ends occur.
 */
export function generateTemporalFilters(
  properties: readonly string[],
  days = ["2022-04-16", "2021-04-16", "2023-04-16", "1970-01-01"],
  instants = ["2022-04-16T10:13:19Z", "2022-04-16T10:15:10Z", "2022-04-16T00:00:00Z", "1969-12-31T23:59:59.999Z", "2022-04-16T10:15:10.0004Z"],
): Cql2Filter[] {
  const ops = [
    "t_after", "t_before", "t_disjoint", "t_equals", "t_intersects", "t_contains", "t_during", "t_finishedBy",
    "t_finishes", "t_meets", "t_metBy", "t_overlappedBy", "t_overlaps", "t_startedBy", "t_starts",
  ];
  const intervals = [
    ...days.flatMap((a, i) => [[a, days[(i + 1) % days.length]!], [a, a], [a, ".."], ["..", a]]),
    ...instants.flatMap((a, i) => [[a, instants[(i + 2) % instants.length]!], [a, a], [a, ".."], ["..", a]]),
    ["..", ".."],
  ].map((interval) => ({ interval }));
  const literals = [...days.map((date) => ({ date })), ...instants.map((timestamp) => ({ timestamp })), ...intervals];
  const leaves: unknown[] = [];
  ops.forEach((op, k) => {
    for (const a of properties) {
      for (const [i, l] of literals.entries()) {
        if ((i + k) % 3 === 0) leaves.push({ op, args: [p(a), l] });
        if ((i + k) % 5 === 0) leaves.push({ op, args: [l, p(a)] });
      }
      for (const b of properties) {
        leaves.push({ op, args: [p(a), p(b)] });
        for (const [i, l] of intervals.entries()) {
          if ((i + k) % 2 === 0) leaves.push({ op, args: [{ interval: [p(a), p(b)] }, l] });
          if ((i + k) % 4 === 1) leaves.push({ op, args: [l, { interval: [p(a), p(b)] }] });
        }
        leaves.push({ op, args: [{ interval: [p(a), ".."] }, { interval: ["..", p(b)] }] });
        leaves.push({ op, args: [{ interval: [p(a), p(a)] }, { interval: [p(b), p(b)] }] });
        leaves.push({ op, args: [{ interval: [p(a), p(b)] }, { interval: [p(b), p(a)] }] });
      }
    }
    leaves.push({ op, args: [intervals[k % intervals.length], intervals[(k * 7 + 3) % intervals.length]] });
  });
  const valid = leaves.filter((f) => validate(f).valid) as Cql2Filter[];
  const nots = valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter);
  const pairs: Cql2Filter[] = [];
  for (let i = 0; i + 1 < valid.length; i += 11) {
    pairs.push({ op: "and", args: [valid[i]!, valid[i + 1]!] }, { op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });
  }
  return [...valid, ...nots, ...pairs];
}

/**
 * The literal sets of the array filters: empty, one element, repeats, the equality traps (`1` / `1.0`, `true` / `1`,
 * `"1"` / `1`, `""`, `"a "`, `"A"`, NFC / NFD), dates and timestamps, and mixed kinds (the standard's examples 81, 82).
 */
export const ARRAY_LITERALS: readonly unknown[][] = [
  [], ["a"], ["a", "b"], ["b", "a", "a"], ["", "a "], ["A"], ["é"], ["é"], ["1"], ["😀", ""],
  [1], [1, 2.5], [0.1], [0], [9007199254740991, -1], [true], [false, true],
  [{ date: "2010-02-10" }], [{ date: "1969-07-16" }, { date: "2010-02-10" }], ["2010-02-10"],
  [{ timestamp: "2010-02-10T05:30:00.123Z" }], [{ timestamp: "2010-02-10T00:00:00Z" }, { timestamp: "1969-07-16T13:32:00Z" }],
  ["a", true, 1.0, 8], [{ timestamp: "2012-08-10T05:30:00Z" }, { date: "2010-02-10" }, false],
];

/**
 * Array filters on the given properties: the four functions with every literal set, the property first (the portable
 * shape), the literal first, two properties and two literals; with NOT, AND and OR.
 */
export function generateArrayFilters(properties: readonly string[]): Cql2Filter[] {
  const ops = ["a_equals", "a_contains", "a_containedBy", "a_overlaps"];
  const leaves: unknown[] = [];
  ops.forEach((op, k) => {
    for (const a of properties) {
      for (const [i, l] of ARRAY_LITERALS.entries()) {
        leaves.push({ op, args: [p(a), l] });
        if ((i + k) % 3 === 0) leaves.push({ op, args: [l, p(a)] });
      }
      for (const b of properties) leaves.push({ op, args: [p(a), p(b)] });
    }
    for (const [i, l] of ARRAY_LITERALS.entries()) {
      if ((i + k) % 4 === 0) leaves.push({ op, args: [l, ARRAY_LITERALS[(i * 5 + k) % ARRAY_LITERALS.length]] });
    }
  });
  const valid = leaves.filter((f) => validate(f).valid) as Cql2Filter[];
  const nots = valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter);
  const pairs: Cql2Filter[] = [];
  for (let i = 0; i + 1 < valid.length; i += 7) {
    pairs.push({ op: "and", args: [valid[i]!, valid[i + 1]!] }, { op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] });
  }
  return [...valid, ...nots, ...pairs];
}
