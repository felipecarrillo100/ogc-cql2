/**
 * `evaluate`: CQL2's three-valued logic. Each operator against a matching value, a non-matching one, a null and a
 * missing property; the standard's Tables 2 and 3; CASEI's case folding; LIKE; dates and instants; type mismatches.
 */
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { evaluate, toEvaluator, toPredicate, type Truth } from "ogc-cql2/evaluate";

const p = (property: string) => ({ property });
const casei = <T>(arg: T) => ({ op: "casei", args: [arg] }) as const;
const accenti = <T>(arg: T) => ({ op: "accenti", args: [arg] }) as const;
const f = (properties: Record<string, unknown>) => ({ type: "Feature", properties, geometry: null });
const F = (filter: unknown) => filter as Cql2Filter;

describe("each operator: match, no match, null, missing", () => {
  const rows: [string, Cql2Filter, unknown, unknown][] = [
    // [name, filter, a matching value, a non-matching value]
    ["=", F({ op: "=", args: [p("v"), 5] }), 5, 6],
    ["<>", F({ op: "<>", args: [p("v"), 5] }), 6, 5],
    ["<", F({ op: "<", args: [p("v"), 5] }), 4, 5],
    ["<=", F({ op: "<=", args: [p("v"), 5] }), 5, 6],
    [">", F({ op: ">", args: [p("v"), 5] }), 6, 5],
    [">=", F({ op: ">=", args: [p("v"), 5] }), 5, 4],
    ["= string", F({ op: "=", args: [p("v"), "BE"] }), "BE", "NL"],
    ["< string", F({ op: "<", args: [p("v"), "b"] }), "a", "c"],
    ["= boolean", F({ op: "=", args: [p("v"), true] }), true, false],
    ["like", F({ op: "like", args: [p("v"), "Riv%"] }), "River", "river"],
    ["between", F({ op: "between", args: [p("v"), 1, 5] }), 5, 6],
    ["in", F({ op: "in", args: [p("v"), ["BE", "NL"]] }), "NL", "DE"],
    ["= date", F({ op: "=", args: [p("v"), { date: "2020-07-26" }] }), "2020-07-26", "2020-07-27"],
    ["< timestamp", F({ op: "<", args: [p("v"), { timestamp: "2023-01-01T00:00:00Z" }] }), "2022-12-31T23:59:59Z", "2023-01-01T00:00:00Z"],
  ];

  it.each(rows)("%s", (_, filter, match, noMatch) => {
    expect(evaluate(filter, f({ v: match }))).toBe(true);
    expect(evaluate(filter, f({ v: noMatch }))).toBe(false);
    // `/req/basic-cql2/binary-comparison-predicate` C, `…/like-predicate` C, `…/between-predicate` C.
    expect(evaluate(filter, f({ v: null }))).toBe(null);
    expect(evaluate(filter, f({}))).toBe(null);
  });

  it("IS NULL is never NULL", () => {
    const isNull = F({ op: "isNull", args: [p("v")] });
    expect(evaluate(isNull, f({ v: null }))).toBe(true);
    expect(evaluate(isNull, f({}))).toBe(true);
    expect(evaluate(isNull, f({ v: 0 }))).toBe(false);
    expect(evaluate(isNull, f({ v: "" }))).toBe(false);
  });

  it("NOT around a comparison on a null value selects nothing, and neither does the comparison", () => {
    const notIn = F({ op: "not", args: [{ op: "in", args: [p("c"), ["BE"]] }] });
    expect(toPredicate(notIn)(f({ c: null }))).toBe(false);
    expect(toPredicate(notIn)(f({ c: "NL" }))).toBe(true);
    expect(toPredicate(F({ op: "in", args: [p("c"), ["BE"]] }))(f({}))).toBe(false);
  });
});

describe("Tables 2 and 3 (AND, OR, NOT)", () => {
  const T = true, Fa = false, N = F({ op: "=", args: [p("missing"), 1] });
  const filterOf = (t: Truth): Cql2Filter => (t === null ? N : t ? T : Fa);
  // [P1, P2, P1 AND P2, P1 OR P2], the rows of Table 2.
  const table2: [Truth, Truth, Truth, Truth][] = [
    [true, true, true, true],
    [true, false, false, true],
    [false, true, false, true],
    [false, false, false, false],
    [true, null, null, true],
    [false, null, false, null],
    [null, true, null, true],
    [null, false, false, null],
    [null, null, null, null],
  ];

  it.each(table2)("%s, %s → AND %s, OR %s", (p1, p2, conj, disj) => {
    const args = [filterOf(p1), filterOf(p2)];
    expect(evaluate({ op: "and", args }, f({}))).toBe(conj);
    expect(evaluate({ op: "or", args }, f({}))).toBe(disj);
  });

  it("Table 3", () => {
    expect(evaluate({ op: "not", args: [T] }, f({}))).toBe(false);
    expect(evaluate({ op: "not", args: [Fa] }, f({}))).toBe(true);
    expect(evaluate({ op: "not", args: [N] }, f({}))).toBe(null);
  });

  it("more than two operands, and nesting", () => {
    expect(evaluate({ op: "and", args: [T, T, N] }, f({}))).toBe(null);
    expect(evaluate({ op: "and", args: [T, N, Fa] }, f({}))).toBe(false);
    expect(evaluate({ op: "or", args: [Fa, N, T] }, f({}))).toBe(true);
    expect(evaluate({ op: "not", args: [{ op: "or", args: [Fa, N] }] }, f({}))).toBe(null);
  });
});

describe("types must match; values are never converted (binary-comparison-predicate D)", () => {
  it.each([
    ["a number compared with a string", F({ op: "=", args: [p("v"), "5"] }), 5],
    ["a string compared with a number", F({ op: "=", args: [p("v"), 5] }), "5"],
    ["a string in BETWEEN", F({ op: "between", args: [p("v"), 1, 9] }), "5"],
    ["a number in LIKE", F({ op: "like", args: [p("v"), "5%"] }), 5],
    ["a boolean compared with a number", F({ op: "=", args: [p("v"), 1] }), true],
    ["a date compared with a timestamp string", F({ op: "=", args: [p("v"), { date: "2020-01-01" }] }), "2020-01-01T00:00:00Z"],
    ["a timestamp compared with a date string", F({ op: "<", args: [p("v"), { timestamp: "2020-01-01T00:00:00Z" }] }), "2019-12-31"],
    ["a timestamp compared with a local time", F({ op: "<", args: [p("v"), { timestamp: "2020-01-01T00:00:00Z" }] }), "2019-12-31T10:00:00"],
    ["an object", F({ op: "=", args: [p("v"), "x"] }), { x: 1 }],
  ])("%s is NULL", (_, filter, value) => {
    expect(evaluate(filter, f({ v: value }))).toBe(null);
    expect(evaluate({ op: "not", args: [filter] }, f({ v: value }))).toBe(null);
  });

  it("IN: a match wins; otherwise a value of another type is NULL", () => {
    expect(evaluate(F({ op: "in", args: [p("v"), [1, 2]] }), f({ v: "1" }))).toBe(null);
    expect(evaluate(F({ op: "in", args: [p("v"), [1, 2]] }), f({ v: 3 }))).toBe(false);
  });
});

describe("dates and instants", () => {
  const ts = (timestamp: string) => ({ timestamp });

  it("a Date matches by its UTC day or its instant", () => {
    expect(evaluate(F({ op: "=", args: [p("v"), { date: "2020-07-26" }] }), f({ v: new Date("2020-07-26T23:30:00Z") }))).toBe(true);
    expect(evaluate(F({ op: "=", args: [p("v"), ts("2020-07-26T23:30:00Z")] }), f({ v: new Date("2020-07-26T23:30:00Z") }))).toBe(true);
  });

  it("an offset in the feature's value is honoured; the fraction, to the millisecond", () => {
    const at = F({ op: "=", args: [p("v"), ts("2023-01-01T00:00:00Z")] });
    expect(evaluate(at, f({ v: "2023-01-01T01:00:00+01:00" }))).toBe(true);
    expect(evaluate(at, f({ v: "2023-01-01T00:00Z" }))).toBe(true);
    expect(evaluate(F({ op: ">", args: [p("v"), ts("2021-06-30T12:00:00.500Z")] }), f({ v: "2021-06-30T12:00:00.501Z" }))).toBe(true);
  });

  it("only real days and instants count: JavaScript's lenient Date.parse is not used", () => {
    const at = F({ op: "=", args: [p("v"), ts("2023-03-02T00:00:00Z")] });
    expect(evaluate(at, f({ v: "2023-02-30T00:00Z" }))).toBe(null); // Date.parse reads it as 2 March
    expect(evaluate(F({ op: "=", args: [p("v"), ts("2023-01-02T00:00:00Z")] }), f({ v: "2023-01-01T24:00Z" }))).toBe(null);
    expect(evaluate(F({ op: "<", args: [p("v"), ts("2024-01-01T00:00:00Z")] }), f({ v: "2023-01-01T10:00:60Z" }))).toBe(null);
    expect(evaluate(F({ op: "=", args: [p("v"), { date: "2020-03-01" }] }), f({ v: "2020-02-30" }))).toBe(null);
    expect(evaluate(F({ op: "=", args: [p("v"), { date: "2020-02-29" }] }), f({ v: "2020-02-29" }))).toBe(true);
    expect(evaluate(F({ op: "=", args: [p("v"), ts("2023-01-01T10:00:00.123Z")] }), f({ v: "2023-01-01t10:00:00.123456z" }))).toBe(true);
  });

  it("dates order by day", () => {
    const range = F({ op: "and", args: [
      { op: ">=", args: [p("v"), { date: "2018-01-01" }] },
      { op: "<=", args: [p("v"), { date: "2018-12-31" }] },
    ] });
    expect(evaluate(range, f({ v: "2018-06-15" }))).toBe(true);
    expect(evaluate(range, f({ v: "2019-01-01" }))).toBe(false);
  });
});

describe("LIKE (like-predicate E–K)", () => {
  const like = (pattern: unknown, value: unknown, subject: unknown = p("v")) =>
    evaluate(F({ op: "like", args: [subject, pattern] }), f({ v: value }));

  it("% is any run, _ one character, \\ escapes", () => {
    expect(like("%", "")).toBe(true);
    expect(like("_%", "")).toBe(false);
    expect(like("", "")).toBe(true);
    expect(like("a_c", "abc")).toBe(true);
    expect(like("a_c", "abbc")).toBe(false);
    expect(like("100\\%", "100%")).toBe(true);
    expect(like("100\\%", "1000")).toBe(false);
    expect(like("a\\_b", "a_b")).toBe(true);
    expect(like("a\\_b", "axb")).toBe(false);
  });

  it("_ matches one code point, also outside the BMP; regular-expression characters are literal", () => {
    expect(like("_", "😀")).toBe(true);
    expect(like("a.c", "abc")).toBe(false);
    expect(like("(x)+[y]", "(x)+[y]")).toBe(true);
    expect(like("line%", "line1\nline2")).toBe(true);
  });

  it("is case-sensitive without CASEI", () => {
    expect(like("riv%", "River")).toBe(false);
    expect(like(casei("riv%"), "River", casei(p("v")))).toBe(true);
  });
});

describe("CASEI: Unicode full case folding (casei-function E)", () => {
  const eqCasei = (literal: string, value: string) =>
    evaluate(F({ op: "=", args: [casei(p("v")), casei(literal)] }), f({ v: value }));

  it.each([
    ["Toronto", "TORONTO"],
    ["Straße", "STRASSE"], // ß → ss (status F)
    ["ﬁle", "FILE"], // the ligature ﬁ → fi (F)
    ["ΣΊΣΥΦΟΣ", "σίσυφος"], // capital sigma folds to σ
    ["σίσυφος", "σίσυφοσ"], // final ς folds to σ (C)
    ["Οδος", "ΟΔΟΣ"],
    ["İstanbul", "i̇stanbul"], // İ → i + combining dot (F)
    ["Ꭰ", "ꭰ"], // Cherokee folds to upper case (C)
    ["Å", "å"], // Å (U+212B, Angstrom sign) → å
  ])("%s ~ %s", (a, b) => {
    expect(eqCasei(a, b)).toBe(true);
  });

  it("composed and decomposed forms are the same (NFC/NFD), with or without CASEI", () => {
    expect(eqCasei("CAFÉ", "café")).toBe(true);
    expect(evaluate(F({ op: "=", args: [p("v"), "café"] }), f({ v: "café" }))).toBe(true);
  });

  it("folds exactly what it wraps", () => {
    // CASEI(v) = 'Abc': the property is folded, the literal is not, so a capital in the literal never matches.
    expect(evaluate(F({ op: "=", args: [casei(p("v")), "Abc"] }), f({ v: "ABC" }))).toBe(false);
    expect(evaluate(F({ op: "=", args: [casei(p("v")), "abc"] }), f({ v: "ABC" }))).toBe(true);
    // v = CASEI('ABC'): the literal is folded, the property is not.
    expect(evaluate(F({ op: "=", args: [p("v"), casei("ABC")] }), f({ v: "abc" }))).toBe(true);
    expect(evaluate(F({ op: "=", args: [p("v"), casei("ABC")] }), f({ v: "ABC" }))).toBe(false);
  });

  it("in IN lists, and on a null", () => {
    const filter = F({ op: "in", args: [casei(p("v")), [casei("Οδος"), casei("Straße")]] });
    expect(evaluate(filter, f({ v: "STRASSE" }))).toBe(true);
    expect(evaluate(filter, f({ v: "road" }))).toBe(false);
    expect(evaluate(filter, f({ v: null }))).toBe(null); // casei-function D
  });
});

describe("ACCENTI: the nonspacing marks removed (accenti-function E)", () => {
  const key = (value: string) => {
    // The value's key is what ACCENTI(v) = ACCENTI(value) matches: test it against itself and its stripped form.
    const filter = F({ op: "=", args: [accenti(p("v")), accenti(value)] });
    return (other: string) => evaluate(filter, f({ v: other }));
  };

  it.each([
    ["São Paulo", "Sao Paulo"],
    ["Bogotá", "Bogota"],
    ["Ação", "Acao"],
    ["año", "ano"], // ñ is n + a combining tilde: the standard's rule removes it
    ["Việt Nam", "Viet Nam"], // two marks on one letter
    ["Ångström", "Angstrom"],
    ["cafe\u0301", "café"], // decomposed input
    ["Łódź", "Łodz"], // ł has no decomposition: a letter of its own, kept
    ["Đà Nẵng", "Đa Nang"], // đ kept
    ["한국", "한국"], // Hangul syllables decompose to jamo and recompose: nothing removed
    ["\u{11107}\u{11134}", "\u{11107}"], // a mark above U+FFFF (Chakma U+11134, on the letter U+11107) is removed
  ])("%s ~ %s", (a, b) => {
    expect(key(a)(b)).toBe(true);
  });

  it.each([
    ["Øresund", "Oresund"], // ø has no decomposition
    ["はじめ", "はしめ"], // the Japanese voicing marks are kept (Recommendation 2)
    ["が", "か"],
    ["Sao", "Sau"],
    ["भारत", "भरत"], // a spacing vowel sign (U+093E, category Mc) is kept: only nonspacing marks (Mn) go
  ])("%s ≁ %s", (a, b) => {
    expect(key(a)(b)).toBe(false);
  });

  it("folds exactly what it wraps, and combines with CASEI either way", () => {
    expect(evaluate(F({ op: "=", args: [accenti(p("v")), "São"] }), f({ v: "Sao" }))).toBe(false); // literal not stripped
    expect(evaluate(F({ op: "=", args: [p("v"), accenti("São")] }), f({ v: "Sao" }))).toBe(true);
    const both = (subject: unknown, literal: unknown) => evaluate(F({ op: "=", args: [subject, literal] }), f({ v: "SÃO PAULO" }));
    expect(both(casei(accenti(p("v"))), casei(accenti("são paulo")))).toBe(true);
    expect(both(accenti(casei(p("v"))), accenti(casei("são paulo")))).toBe(true);
    expect(both(accenti(p("v")), accenti("são paulo"))).toBe(false); // case still matters
  });

  it("recomposes what remains: a kept mark or a Hangul syllable is still one character for LIKE's _", () => {
    const one = (value: string) => evaluate(F({ op: "like", args: [accenti(p("v")), accenti("_")] }), f({ v: value }));
    expect(one("が")).toBe(true); // か + the kept voicing mark, recomposed
    expect(one("한")).toBe(true); // three jamo after decomposition, recomposed
    expect(one("é")).toBe(true);
  });

  it("in LIKE, IN, order, and on a null", () => {
    expect(evaluate(F({ op: "like", args: [accenti(p("v")), accenti("Sao%")] }), f({ v: "São Paulo" }))).toBe(true);
    expect(evaluate(F({ op: "like", args: [casei(accenti(p("v"))), casei(accenti("%PAULO"))] }), f({ v: "São Paulo" }))).toBe(true);
    const list = F({ op: "in", args: [accenti(p("v")), [accenti("Bogotá"), accenti("Medellín")]] });
    expect(evaluate(list, f({ v: "Medellin" }))).toBe(true);
    expect(evaluate(list, f({ v: null }))).toBe(null); // accenti-function D
    expect(evaluate(F({ op: "<", args: [accenti(p("v")), accenti("é")] }), f({ v: "f" }))).toBe(false); // e < f, not é
    expect(evaluate(F({ op: "<", args: [accenti(p("v")), accenti("f")] }), f({ v: "é" }))).toBe(true);
  });
});

describe("spatial relations other than S_INTERSECTS: no engine yet", () => {
  it("are refused with unsupported, naming the class, instead of being evaluated", () => {
    const filter = F({ op: "and", args: [{ op: "=", args: [p("a"), 1] }, { op: "s_within", args: [p("geometry"), { bbox: [0, 0, 1, 1] }] }] });
    expect(() => toPredicate(filter)).toThrow(
      expect.objectContaining({ name: "Cql2Error", code: "unsupported", details: { conformance: "http://www.opengis.net/spec/cql2/1.0/conf/spatial-functions" } }),
    );
  });
});

describe("string order is code point order (as a binary SQL comparison on UTF-8)", () => {
  it("U+E000 sorts before 😀 (U+1F600), although JavaScript's UTF-16 order says the opposite", () => {
    expect("" < "😀").toBe(false); // JavaScript's own order, for the record
    expect(evaluate(F({ op: "<", args: [p("v"), "😀"] }), f({ v: "" }))).toBe(true);
    expect(evaluate(F({ op: ">", args: [p("v"), ""] }), f({ v: "😀" }))).toBe(true);
    expect(evaluate(F({ op: "<", args: [p("v"), "b"] }), f({ v: "a" }))).toBe(true);
    expect(evaluate(F({ op: "<", args: [p("v"), "ab"] }), f({ v: "a" }))).toBe(true);
  });
});

describe("the API", () => {
  it("toEvaluator and toPredicate compile once; getProperty reads other feature shapes", () => {
    const filter = F({ op: ">", args: [p("height"), 10] });
    const rows = [{ height: 5 }, { height: 20 }, { height: null }];
    const getProperty = (row: Record<string, unknown>, name: string) => row[name];
    expect(rows.map(toEvaluator(filter, { getProperty }))).toEqual([false, true, null]);
    expect(rows.filter(toPredicate(filter, { getProperty }))).toEqual([{ height: 20 }]);
  });

  it("true and false select all and none", () => {
    expect(evaluate(true, f({}))).toBe(true);
    expect(evaluate(false, f({}))).toBe(false);
  });

  it("refuses an invalid filter with invalid-filter", () => {
    expect(() => toPredicate({ op: "eq", property: "a", value: 1 } as never)).toThrow(
      expect.objectContaining({ code: "invalid-filter" }),
    );
  });
});
