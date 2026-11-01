/**
 * `fromText`: the grammar (`cql2.bnf`, tag `cql2-1.0.0`) case by case. Keywords, whitespace, operators, character
 * literals and their escapes (Requirement 21), numbers, minus, the NOT forms, BETWEEN's AND, geometries, instants,
 * names, and the refusals with their positions. The standard's own examples are in `ogc-examples.test.ts`; the round
 * trips with `toText` in `parse-roundtrip.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { CONFORMANCE, OTHER_CONFORMANCE } from "ogc-cql2";
import { fromText } from "ogc-cql2/parse";
import { readText } from "../src/parse/read.ts";

const p = (property: string) => ({ property });
const eq = (property: string, value: unknown) => ({ op: "=", args: [p(property), value] });

/** The refusal of a text: its code, position and what was expected. */
function refusal(text: string): { code: string; position: unknown; message: string } {
  try {
    readText(text);
  } catch (error) {
    const e = error as { code: string; details: { position: unknown }; message: string };
    return { code: e.code, position: e.details.position, message: e.message };
  }
  throw new Error(`read: ${text}`);
}
const refusedAt = (text: string, position: number) => expect(refusal(text)).toMatchObject({ code: "invalid-text", position });

describe("keywords and whitespace", () => {
  it("keywords in any case (ABNF strings are case-insensitive)", () => {
    expect(readText("a = 1 AnD b IS not null")).toEqual({ op: "and", args: [eq("a", 1), { op: "not", args: [{ op: "isNull", args: [p("b")] }] }] });
    expect(readText("s_intersects(g, point(1 2))")).toEqual({ op: "s_intersects", args: [p("g"), { type: "Point", coordinates: [1, 2] }] });
    expect(readText("d = date('2020-01-01')")).toEqual(eq("d", { date: "2020-01-01" }));
    expect(readText("true")).toBe(true);
  });

  it("only ASCII letters fold: ſ (long s) upper-cases to S in Unicode, but ſ_intersects isn't a keyword", () => {
    expect(readText("ſ_intersects = 1")).toEqual(eq("ſ_intersects", 1));
  });

  it("whitespace is the grammar's own 25 characters, anywhere between tokens", () => {
    const spaces = "\t\n\v\f\r \u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000";
    expect([...spaces]).toHaveLength(25);
    // Each one after a token that isn't a name (U+1680 after a name is the next test's).
    for (const c of spaces) expect(readText(`${c}(${c}a =${c}1${c})${c}AND (b <>${c}2${c})${c}`)).toEqual(
      { op: "and", args: [eq("a", 1), { op: "<>", args: [p("b"), 2] }] },
    );
    expect(readText("a=1AND b<>2")).toEqual({ op: "and", args: [eq("a", 1), { op: "<>", args: [p("b"), 2] }] });
  });

  it("U+1680 (Ogham space mark) is in both `whitespace` and `identifierStart`: after a name, it is part of it (as toText writes such a name)", () => {
    expect(readText("a\u1680= 1")).toEqual(eq("a\u1680", 1));
    expect(readText("a =\u16801")).toEqual(eq("a", 1));
  });

  it("not JavaScript's other whitespace: U+FEFF is an identifier character (`identifierStart` U+FDF0\u2013U+FFFD), not a space", () => {
    expect(readText("a\uFEFF = 1")).toEqual(eq("a\uFEFF", 1));
    refusedAt("a = 1\uFEFF", 5);
  });
});

describe("comparison operators", () => {
  it.each(["=", "<>", "<", "<=", ">", ">="])("%s", (op) => {
    expect(readText(`a ${op} 1`)).toEqual({ op, args: [p("a"), 1] });
  });

  it("<> <= >= are two terminals in the grammar: a space between them is allowed", () => {
    expect(readText("a < > 1")).toEqual({ op: "<>", args: [p("a"), 1] });
    expect(readText("a < = 1")).toEqual({ op: "<=", args: [p("a"), 1] });
    expect(readText("a > = 1")).toEqual({ op: ">=", args: [p("a"), 1] });
  });

  it("!= isn't CQL2: refused, with a hint", () => {
    expect(refusal("a != 1")).toMatchObject({ code: "invalid-text", position: 2, message: expect.stringContaining("<>") });
  });

  it("either side may be a literal or a property (Property-Property is the profile's business, not the grammar's)", () => {
    expect(readText("'a' = x")).toEqual({ op: "=", args: ["a", p("x")] });
    expect(readText("a = b")).toEqual({ op: "=", args: [p("a"), p("b")] });
  });
});

describe("character literals (Requirement 21, /req/cql2-text/escaping)", () => {
  it("a quote as '' or \\'", () => {
    expect(readText("s = 'it''s'")).toEqual(eq("s", "it's"));
    expect(readText("s = 'it\\'s'")).toEqual(eq("s", "it's"));
    expect(readText("s = ''''")).toEqual(eq("s", "'"));
    expect(readText("s = ''")).toEqual(eq("s", ""));
  });

  it("\\a \\b \\t \\n \\v \\f \\r: BEL, BS, HT, LF, VT, FF, CR", () => {
    expect(readText("s = '\\a\\b\\t\\n\\v\\f\\r'")).toEqual(eq("s", "\x07\b\t\n\v\f\r"));
  });

  it("those characters may also be written as they are: they are in the grammar's alpha and whitespace", () => {
    expect(readText("s = '\x07\b\t\n\v\f\r'")).toEqual(eq("s", "\x07\b\t\n\v\f\r"));
  });

  it("in a LIKE pattern, \\% and \\_ stay: they are the pattern's own escapes, in CQL2-JSON too", () => {
    expect(readText("s LIKE '50\\%'")).toEqual({ op: "like", args: [p("s"), "50\\%"] });
    expect(readText("s LIKE CASEI(ACCENTI('a\\_b%'))")).toEqual({
      op: "like",
      args: [p("s"), { op: "casei", args: [{ op: "accenti", args: ["a\\_b%"] }] }],
    });
    expect(readText("s LIKE 'it\\'s\\n%'")).toEqual({ op: "like", args: [p("s"), "it's\n%"] });
  });

  it("any other backslash has no meaning in the standard: refused where it is", () => {
    refusedAt("s = 'a\\xb'", 6);
    refusedAt("s = 'a\\\\b'", 6);
    refusedAt("s = '50\\%'", 7); // outside a LIKE pattern
    refusedAt("s LIKE 'a\\x'", 9);
    refusedAt("x IN ('ok', 'C:\\data')", 15);
    // \t is a tab, so this one reads: 'C:<tab>emp'.
    expect(readText("x IN ('ok', 'C:\\temp')")).toEqual({ op: "in", args: [p("x"), ["ok", "C:\temp"]] });
  });

  it("a character a literal can't hold (outside the grammar's `character`): U+0000–U+0006, U+000E–U+001F, U+FFFE, U+FFFF, lone surrogates", () => {
    for (const c of ["\u0000", "\u0006", "\u000E", "\u001F", "\uFFFE", "\uFFFF", "\uD83D", "\uDE00"]) {
      expect(refusal(`s = 'a${c}b'`)).toMatchObject({ code: "invalid-text", position: 6 });
    }
    expect(readText("s = '😀\u{10FFFF}\uFFFD\u007F'")).toEqual(eq("s", "😀\u{10FFFF}\uFFFD\u007F"));
  });

  it("an unterminated string, also one whose last quote is escaped", () => {
    refusedAt("a = 'open", 4);
    refusedAt("a = 'end\\'", 4);
  });
});

describe("numbers", () => {
  it("the grammar's forms: 1, 1., 1.5, .5, exponents with E or e, a sign, leading zeros", () => {
    const cases: [string, number][] = [
      ["1", 1], ["1.", 1], ["1.5", 1.5], [".5", 0.5], ["1E5", 1e5], ["1e5", 1e5], ["1.5E-7", 1.5e-7], ["2E+21", 2e21],
      ["+1", 1], ["-1", -1], ["- 1", -1], ["00012", 12], ["0.9653517007827759", 0.9653517007827759],
      ["206289291381835.94", 206289291381835.94], ["9007199254740993", 9007199254740992],
    ];
    for (const [text, value] of cases) expect(readText(`x = ${text}`)).toEqual(eq("x", value));
  });

  it("at least one digit", () => {
    refusedAt("x = .", 4);
    refusedAt("x = 1E", 5);
  });
});

describe("arithmetic and minus", () => {
  it("-1 is the number; minus before a property or a function is * -1", () => {
    expect(readText("x = -1")).toEqual(eq("x", -1));
    expect(readText("-x > 1")).toEqual({ op: ">", args: [{ op: "*", args: [-1, p("x")] }, 1] });
    expect(readText("-f(x) > 1")).toEqual({ op: ">", args: [{ op: "*", args: [-1, { op: "f", args: [p("x")] }] }, 1] });
    refusedAt("x = -'a'", 5);
  });

  it("precedence: ^ over * / % div over + -, left to right, parentheses first", () => {
    expect(readText("x - 1 - 2 > 0")).toEqual({ op: ">", args: [{ op: "-", args: [{ op: "-", args: [p("x"), 1] }, 2] }, 0] });
    expect(readText("x -1 > 2")).toEqual({ op: ">", args: [{ op: "-", args: [p("x"), 1] }, 2] });
    expect(readText("a + b * c ^ 2 = 1")).toEqual({
      op: "=",
      args: [{ op: "+", args: [p("a"), { op: "*", args: [p("b"), { op: "^", args: [p("c"), 2] }] }] }, 1],
    });
    expect(readText("x DIV 2 % 3 = 1")).toEqual({ op: "=", args: [{ op: "%", args: [{ op: "div", args: [p("x"), 2] }, 3] }, 1] });
    expect(readText("2 * (x + 1) > 3")).toEqual({ op: ">", args: [{ op: "*", args: [2, { op: "+", args: [p("x"), 1] }] }, 3] });
    expect(readText("(x + 1) / 2 >= 3")).toEqual({ op: ">=", args: [{ op: "/", args: [{ op: "+", args: [p("x"), 1] }, 2] }, 3] });
  });
});

describe("the logical operators", () => {
  it("AND over OR; a chain is one n-ary and / or; parentheses keep their nesting", () => {
    const [a, b, c] = [eq("a", 1), eq("b", 1), eq("c", 1)];
    expect(readText("a = 1 OR b = 1 AND c = 1")).toEqual({ op: "or", args: [a, { op: "and", args: [b, c] }] });
    expect(readText("a = 1 AND b = 1 AND c = 1")).toEqual({ op: "and", args: [a, b, c] });
    expect(readText("(a = 1 AND b = 1) AND c = 1")).toEqual({ op: "and", args: [{ op: "and", args: [a, b] }, c] });
    expect(readText("((a = 1))")).toEqual(a);
  });

  it("NOT binds to the next predicate; NOT NOT needs parentheses (`booleanFactor = [\"NOT\"] booleanPrimary`)", () => {
    expect(readText("NOT a = 1 AND b = 1")).toEqual({ op: "and", args: [{ op: "not", args: [eq("a", 1)] }, eq("b", 1)] });
    expect(readText("NOT (NOT a = 1)")).toEqual({ op: "not", args: [{ op: "not", args: [eq("a", 1)] }] });
    refusedAt("NOT NOT a = 1", 4);
  });

  it("x NOT LIKE, x NOT BETWEEN, x NOT IN and x IS NOT NULL are NOT of the predicate, as the standard's JSON writes them", () => {
    expect(readText("s NOT LIKE 'x%'")).toEqual({ op: "not", args: [{ op: "like", args: [p("s"), "x%"] }] });
    expect(readText("n NOT BETWEEN 1 AND 2")).toEqual({ op: "not", args: [{ op: "between", args: [p("n"), 1, 2] }] });
    expect(readText("s NOT IN ('a', 'b')")).toEqual({ op: "not", args: [{ op: "in", args: [p("s"), ["a", "b"]] }] });
    expect(readText("s IS NOT NULL")).toEqual({ op: "not", args: [{ op: "isNull", args: [p("s")] }] });
    expect(readText("NOT s IS NULL")).toEqual({ op: "not", args: [{ op: "isNull", args: [p("s")] }] });
  });

  it("BETWEEN takes the next AND; the ones after it join the expression", () => {
    expect(readText("n BETWEEN 1 AND 2 AND m = 3")).toEqual({ op: "and", args: [{ op: "between", args: [p("n"), 1, 2] }, eq("m", 3)] });
    expect(readText("n BETWEEN 1 AND 2 OR m = 3")).toEqual({ op: "or", args: [{ op: "between", args: [p("n"), 1, 2] }, eq("m", 3)] });
  });

  it("a value isn't a predicate: AND, OR, NOT and the whole filter need TRUE / FALSE", () => {
    refusedAt("x", 1);
    refusedAt("x AND y = 1", 2);
    refusedAt("NOT x", 5);
    refusedAt("(a = 1) = TRUE", 0);
    expect(readText("Foo(x)")).toEqual({ op: "Foo", args: [p("x")] }); // a function may give TRUE / FALSE
    expect(readText("(a = 1) IS NULL")).toEqual({ op: "isNull", args: [eq("a", 1)] }); // `isNullOperand` holds booleanExpression
  });
});

describe("LIKE, IN, CASEI, ACCENTI", () => {
  it("LIKE's pattern is a string, or CASEI / ACCENTI of one (`patternExpression`)", () => {
    expect(readText("CASEI(s) LIKE CASEI('x%')")).toEqual({ op: "like", args: [{ op: "casei", args: [p("s")] }, { op: "casei", args: ["x%"] }] });
    refusedAt("s LIKE 5", 7);
    refusedAt("s LIKE t", 7);
  });

  it("IN needs at least one item (`inList`)", () => {
    expect(readText("x IN (1)")).toEqual({ op: "in", args: [p("x"), [1]] });
    refusedAt("x IN ()", 6);
  });

  it("CASEI / ACCENTI wrap a string, a property, a function or each other (`characterExpression`)", () => {
    expect(readText("ACCENTI(CASEI(s)) = CASEI(ACCENTI('São'))")).toEqual({
      op: "=",
      args: [{ op: "accenti", args: [{ op: "casei", args: [p("s")] }] }, { op: "casei", args: [{ op: "accenti", args: ["São"] }] }],
    });
    expect(readText('CASEI("date") = CASEI(f(x))')).toEqual({ op: "=", args: [{ op: "casei", args: [p("date")] }, { op: "casei", args: [{ op: "f", args: [p("x")] }] }] });
    refusedAt("CASEI(1) = 'a'", 6);
  });
});

describe("names", () => {
  it("identifiers per the grammar: _ and : start one, . and digits continue it", () => {
    expect(readText("_x = 1")).toEqual(eq("_x", 1));
    expect(readText("eo:cloud_cover.max2 = 1")).toEqual(eq("eo:cloud_cover.max2", 1));
    refusedAt("1a = 1", 1);
  });

  it("a keyword is always the keyword: a property named like one is written in double quotes", () => {
    expect(readText('"date" = 1')).toEqual(eq("date", 1));
    expect(readText('"AND" IS NULL')).toEqual({ op: "isNull", args: [p("AND")] });
    expect(refusal("date = 1")).toMatchObject({ code: "invalid-text", position: 5, message: expect.stringContaining('written "date"') });
    expect(refusal("x = and")).toMatchObject({ code: "invalid-text", position: 4, message: expect.stringContaining('written "and"') });
  });

  it("only an identifier can be quoted", () => {
    refusedAt('"a b" = 1', 0);
    refusedAt('"open = 1', 0);
  });

  it("a function keeps its name as written, with any arguments, also none, also predicates", () => {
    expect(readText("Foo(\"geometry\") = TRUE")).toEqual({ op: "=", args: [{ op: "Foo", args: [p("geometry")] }, true] });
    expect(readText("now() > 1")).toEqual({ op: ">", args: [{ op: "now", args: [] }, 1] });
    expect(readText("f(a = 1, b, 'c', (1, 2)) = TRUE")).toEqual({
      op: "=",
      args: [{ op: "f", args: [eq("a", 1), p("b"), "c", [1, 2]] }, true],
    });
  });
});

describe("spatial, temporal and array predicates", () => {
  const g = (literal: string) => (readText(`S_INTERSECTS(g, ${literal})`) as { args: unknown[] }).args[1];

  it("each geometry, as GeoJSON", () => {
    expect(g("POINT(1 2)")).toEqual({ type: "Point", coordinates: [1, 2] });
    expect(g("LINESTRING(1 2, 3 4)")).toEqual({ type: "LineString", coordinates: [[1, 2], [3, 4]] });
    expect(g("POLYGON((0 0, 1 0, 1 1, 0 0), (0.1 0.1, 0.2 0.1, 0.2 0.2, 0.1 0.1))")).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.1]]],
    });
    expect(g("MULTIPOINT((1 2), (3 4))")).toEqual({ type: "MultiPoint", coordinates: [[1, 2], [3, 4]] });
    expect(g("MULTILINESTRING((1 2, 3 4), (5 6, 7 8))")).toEqual({ type: "MultiLineString", coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] });
    expect(g("MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)))")).toEqual({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] });
    expect(g("GEOMETRYCOLLECTION(POINT(1 2), LINESTRING Z(1 2 3, 4 5 6))")).toEqual({
      type: "GeometryCollection",
      geometries: [{ type: "Point", coordinates: [1, 2] }, { type: "LineString", coordinates: [[1, 2, 3], [4, 5, 6]] }],
    });
    expect(g("BBOX(-180, -90, 180, 90)")).toEqual({ bbox: [-180, -90, 180, 90] });
    expect(g("BBOX(1, 2, 0, 3, 4, 9)")).toEqual({ bbox: [1, 2, 0, 3, 4, 9] });
  });

  it("Z is optional; the coordinates tell the dimension (Requirement 26); positions are kept as written", () => {
    expect(g("POINT Z(1 2)")).toEqual({ type: "Point", coordinates: [1, 2] });
    expect(g("POINT(1 2 3)")).toEqual({ type: "Point", coordinates: [1, 2, 3] });
    expect(g("point z(-1 +2 3)")).toEqual({ type: "Point", coordinates: [-1, 2, 3] });
    expect(g("LINESTRING(1 2, 3 4 5)")).toEqual({ type: "LineString", coordinates: [[1, 2], [3, 4, 5]] });
  });

  it("refused: EMPTY, a MULTIPOINT without each point's parentheses, POINTZ, too few points, a collection in a collection, a wrong BBOX", () => {
    expect(refusal("S_INTERSECTS(g, POINT EMPTY)")).toMatchObject({ position: 22, message: expect.stringContaining("no empty geometries") });
    expect(refusal("S_INTERSECTS(g, MULTIPOINT(1 2, 3 4))")).toMatchObject({ position: 27, message: expect.stringContaining("MULTIPOINT((1 2), (3 4))") });
    refusedAt("S_INTERSECTS(g, POINTZ(1 2 3))", 25);
    refusedAt("S_INTERSECTS(g, LINESTRING(1 2))", 27);
    refusedAt("S_INTERSECTS(g, POLYGON((0 0, 1 0, 0 0)))", 25);
    refusedAt("S_INTERSECTS(g, GEOMETRYCOLLECTION(GEOMETRYCOLLECTION(POINT(1 2))))", 35);
    refusedAt("S_INTERSECTS(g, BBOX(1, 2, 3))", 21);
  });

  it("every relation, temporal and array function, with the standard's JSON names", () => {
    for (const op of ["s_intersects", "s_equals", "s_disjoint", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"]) {
      expect(readText(`${op.toUpperCase()}(g, POINT(1 2))`)).toEqual({ op, args: [p("g"), { type: "Point", coordinates: [1, 2] }] });
    }
    const temporal = ["t_after", "t_before", "t_contains", "t_disjoint", "t_during", "t_equals", "t_finishedBy", "t_finishes", "t_intersects", "t_meets", "t_metBy", "t_overlappedBy", "t_overlaps", "t_startedBy", "t_starts"];
    for (const op of temporal) expect(readText(`${op.toUpperCase()}(t, DATE('2020-01-01'))`)).toEqual({ op, args: [p("t"), { date: "2020-01-01" }] });
    for (const op of ["a_equals", "a_contains", "a_containedBy", "a_overlaps"]) {
      expect(readText(`${op.toUpperCase()}(arr, ('a'))`)).toEqual({ op, args: [p("arr"), ["a"]] });
    }
    expect(readText("A_EQUALS(arr, ())")).toEqual({ op: "a_equals", args: [p("arr"), []] });
    expect(readText("A_OVERLAPS(arr, (1, ('x', TRUE)))")).toEqual({ op: "a_overlaps", args: [p("arr"), [1, ["x", true]]] });
  });
});

describe("instants", () => {
  it("DATE and TIMESTAMP with the grammar's shapes, in UTC", () => {
    expect(readText("t = TIMESTAMP('2020-01-01T00:00:00Z')")).toEqual(eq("t", { timestamp: "2020-01-01T00:00:00Z" }));
    expect(readText("t = TIMESTAMP('2020-01-01T00:00:00.123456Z')")).toEqual(eq("t", { timestamp: "2020-01-01T00:00:00.123456Z" }));
    refusedAt("t = TIMESTAMP('2020-01-01T00:00:00+01:00')", 14);
    refusedAt("t = TIMESTAMP('2020-01-01T00:00:00z')", 14);
    refusedAt("t = DATE('2020-1-01')", 9);
    refusedAt("t = DATE(x)", 9);
  });

  it("INTERVAL: dates, timestamps, '..', properties, functions", () => {
    expect(readText("T_INTERSECTS(t, INTERVAL('2020-01-01', '..'))")).toEqual({ op: "t_intersects", args: [p("t"), { interval: ["2020-01-01", ".."] }] });
    expect(readText('T_DURING(INTERVAL(a, "date"), INTERVAL(f(), \'2020-01-01T00:00:00Z\'))')).toEqual({
      op: "t_during",
      args: [{ interval: [p("a"), p("date")] }, { interval: [{ op: "f", args: [] }, "2020-01-01T00:00:00Z"] }],
    });
    refusedAt("T_INTERSECTS(t, INTERVAL('soon', '..'))", 25);
  });
});

describe("strict to the end", () => {
  it.each([
    ["", 0], ["   ", 3], ["a =", 3], ["a = 1)", 5], ["(a = 1", 6], ["a = 1 b", 6], ["a = 1 AND", 9], ["S_INTERSECTS(g, POINT(1 2)", 26],
  ])("%j is refused at %i", (text, position) => {
    refusedAt(text, position);
  });

  it("nesting far deeper than any filter reads; deeper still is refused, not a crash", () => {
    expect(readText(`${"(".repeat(300)}a = 1${")".repeat(300)}`)).toEqual(eq("a", 1));
    expect(refusal(`${"(".repeat(100_000)}a = 1${")".repeat(100_000)}`)).toMatchObject({ code: "invalid-text", message: expect.stringContaining("nested too deeply") });
  });

  it("the message quotes the text near the position", () => {
    expect(refusal("name = 'x' extra").message).toBe(
      'Not CQL2-text at position 11, near "name = \'x\' extra": expected AND, OR or the end of the text, found "extra".',
    );
  });
});

describe("fromText: the profile check after the reading", () => {
  it("gives the filter", () => {
    expect(fromText("a = 1 AND s LIKE 'x%'")).toEqual({ op: "and", args: [eq("a", 1), { op: "like", args: [p("s"), "x%"] }] });
  });

  it("refuses valid CQL2 outside the profile as invalid-filter, naming the class", () => {
    expect(() => fromText("T_AFTER(t, DATE('2020-01-01'))")).toThrow(
      expect.objectContaining({ code: "invalid-filter", details: { problems: [expect.objectContaining({ conformance: OTHER_CONFORMANCE.temporal })] } }),
    );
    expect(() => fromText("x + 1 > 2")).toThrow(
      expect.objectContaining({ code: "invalid-filter", details: { problems: [expect.objectContaining({ conformance: OTHER_CONFORMANCE.arithmetic })] } }),
    );
  });

  it("refuses what isn't CQL2-text as invalid-text, before any profile check", () => {
    expect(() => fromText("a = ")).toThrow(expect.objectContaining({ code: "invalid-text", path: "", details: { position: 4, expected: expect.any(String) } }));
    expect(() => fromText(42 as never)).toThrow(expect.objectContaining({ code: "invalid-text" }));
  });

  it("passes the options to the check: queryables, a server's conformance classes", () => {
    expect(() => fromText("a = 1", { queryables: { b: { type: "integer" } } })).toThrow(
      expect.objectContaining({ code: "invalid-filter", details: { problems: [expect.objectContaining({ code: "unknown-property" })] } }),
    );
    expect(() => fromText("s LIKE 'x%'", { conformance: [CONFORMANCE.basic] })).toThrow(expect.objectContaining({ code: "invalid-filter" }));
    expect(fromText("a = 1", { queryables: { a: { type: "integer" } }, conformance: [CONFORMANCE.basic] })).toEqual(eq("a", 1));
  });
});
