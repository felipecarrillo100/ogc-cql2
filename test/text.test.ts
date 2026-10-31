/**
 * `toText`: every operator, the quoting of names and strings, LIKE patterns, numbers, dates, nesting, and what
 * CQL2-text can't express.
 */
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { isIdentifier, quoteString, textProblem, toText } from "ogc-cql2/text";

const p = (property: string) => ({ property });
const casei = <T>(arg: T) => ({ op: "casei", args: [arg] }) as const;
const accenti = <T>(arg: T) => ({ op: "accenti", args: [arg] }) as const;
const eq = (property: string, value: unknown) => ({ op: "=", args: [p(property), value] }) as unknown as Cql2Filter;

const cases: [Cql2Filter, string][] = [
  [eq("F_CODE", "AP030"), "F_CODE = 'AP030'"],
  [{ op: "<>", args: [p("a"), 1] }, "a <> 1"],
  [{ op: ">", args: [p("a"), 1.5] }, "a > 1.5"],
  [{ op: ">=", args: [p("a"), -2] }, "a >= -2"],
  [{ op: "<", args: [p("a"), 3] }, "a < 3"],
  [{ op: "<=", args: [p("a"), 3] }, "a <= 3"],
  [eq("b", true), "b = TRUE"],
  [eq("b", false), "b = FALSE"],
  [{ op: "isNull", args: [p("a")] }, "a IS NULL"],
  [{ op: "not", args: [{ op: "isNull", args: [p("a")] }] }, "NOT (a IS NULL)"],
  [{ op: "between", args: [p("a"), 1, 5] }, "a BETWEEN 1 AND 5"],
  [{ op: "in", args: [p("c"), ["BE", "NL"]] }, "c IN ('BE', 'NL')"],
  [{ op: "not", args: [{ op: "in", args: [p("c"), [1, 2]] }] }, "NOT (c IN (1, 2))"],
  [{ op: "like", args: [p("n"), "Riv%"] }, "n LIKE 'Riv%'"],
  [{ op: "like", args: [casei(p("n")), casei("Riv%")] }, "CASEI(n) LIKE CASEI('Riv%')"],
  [{ op: "like", args: [p("n"), "R_v%"] }, "n LIKE 'R_v%'"],
  [{ op: "like", args: [p("n"), "100\\%\\_%"] }, "n LIKE '100\\%\\_%'"],
  [{ op: "=", args: [casei(p("owner")), casei("somebody else")] }, "CASEI(owner) = CASEI('somebody else')"],
  [{ op: "=", args: [accenti(p("etat_vol")), accenti("débárquér")] }, "ACCENTI(etat_vol) = ACCENTI('débárquér')"],
  [{ op: "=", args: [casei(accenti(p("n"))), casei(accenti("São"))] }, "CASEI(ACCENTI(n)) = CASEI(ACCENTI('São'))"],
  [{ op: "like", args: [accenti(casei(p("n"))), accenti(casei("sao%"))] }, "ACCENTI(CASEI(n)) LIKE ACCENTI(CASEI('sao%'))"],
  [{ op: "in", args: [casei(p("road_class")), [casei("Οδος"), casei("Straße")]] }, "CASEI(road_class) IN (CASEI('Οδος'), CASEI('Straße'))"],
  [eq("name", "O'Brien"), "name = 'O''Brien'"],
  [eq("strasse.klasse", "A"), "strasse.klasse = 'A'"],
  [eq("date", 1), '"date" = 1'],
  [eq("opened", { date: "2020-01-01" }), "opened = DATE('2020-01-01')"],
  [{ op: ">=", args: [p("inspected"), { timestamp: "2023-01-01T00:00:00Z" }] }, "inspected >= TIMESTAMP('2023-01-01T00:00:00Z')"],
  [{ op: "in", args: [p("opened"), [{ date: "2020-07-26" }, { date: "2022-09-11" }]] }, "opened IN (DATE('2020-07-26'), DATE('2022-09-11'))"],
  [
    { op: "and", args: [eq("a", 1), { op: "or", args: [{ op: "<", args: [p("b"), 2] }, { op: "isNull", args: [p("c")] }] }] },
    "(a = 1) AND ((b < 2) OR (c IS NULL))",
  ],
  [{ op: "or", args: [eq("a", 1), eq("a", 2), eq("a", 3)] }, "(a = 1) OR (a = 2) OR (a = 3)"],
  [{ op: "not", args: [eq("a", 1)] }, "NOT (a = 1)"],
  [true, "TRUE"],
  [false, "FALSE"],
  [{ op: "and", args: [true, false] }, "(TRUE) AND (FALSE)"],
];

describe("geometries, as WKT per the grammar", () => {
  const s = (literal: unknown, op = "s_intersects") => toText({ op, args: [p("geom"), literal] } as Cql2Filter);
  it.each([
    [{ type: "Point", coordinates: [7.02, 49.92] }, "S_INTERSECTS(geom, POINT(7.02 49.92))"],
    [{ type: "Point", coordinates: [-1.5, 2, 300] }, "S_INTERSECTS(geom, POINT Z(-1.5 2 300))"],
    [{ type: "LineString", coordinates: [[0, 0], [1, 1.5e-7]] }, "S_INTERSECTS(geom, LINESTRING(0 0, 1 1.5E-7))"],
    [{ type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] },
      "S_INTERSECTS(geom, POLYGON((0 0, 4 0, 4 4, 0 0), (1 1, 2 1, 2 2, 1 1)))"],
    [{ type: "MultiPoint", coordinates: [[0, 0], [1, 1]] }, "S_INTERSECTS(geom, MULTIPOINT((0 0), (1 1)))"],
    [{ type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, "S_INTERSECTS(geom, MULTILINESTRING((0 0, 1 1), (2 2, 3 3)))"],
    [{ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }, "S_INTERSECTS(geom, MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0))))"],
    [{ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2] }, { type: "LineString", coordinates: [[0, 0, 1], [1, 1, 2]] }] },
      "S_INTERSECTS(geom, GEOMETRYCOLLECTION(POINT(1 2), LINESTRING Z(0 0 1, 1 1 2)))"],
    [{ bbox: [0, 40, 10, 50] }, "S_INTERSECTS(geom, BBOX(0, 40, 10, 50))"],
    [{ bbox: [-128.1, -1.1, -99999, 180, 90, 100000] }, "S_INTERSECTS(geom, BBOX(-128.1, -1.1, -99999, 180, 90, 100000))"],
  ])("%j", (literal, text) => {
    expect(s(literal)).toBe(text);
  });

  it("each relation, upper case; a property name that is a keyword is quoted", () => {
    expect(s({ bbox: [0, 0, 1, 1] }, "s_within")).toBe("S_WITHIN(geom, BBOX(0, 0, 1, 1))");
    expect(toText({ op: "s_contains", args: [p("point"), { type: "Point", coordinates: [0, 0] }] } as Cql2Filter)).toBe('S_CONTAINS("point", POINT(0 0))');
  });

  it("refuses a geometry mixing 2D and 3D positions: WKT's Z covers the whole geometry", () => {
    const mixed = { op: "s_intersects", args: [p("geom"), { type: "LineString", coordinates: [[0, 0], [1, 1, 5]] }] } as Cql2Filter;
    expect(textProblem(mixed)).toEqual({ problem: "mixed-dimensions", path: "/args/1" });
    expect(() => toText(mixed)).toThrow(expect.objectContaining({ code: "not-expressible" }));
  });
});

describe("toText", () => {
  it.each(cases)("%j → %s", (filter, text) => {
    expect(toText(filter)).toBe(text);
  });

  it("refuses an invalid filter with invalid-filter", () => {
    expect(() => toText({ op: "eq", property: "a", value: 1 } as never)).toThrow(
      expect.objectContaining({ name: "Cql2Error", code: "invalid-filter" }),
    );
  });
});

// Derived from the standard, CQL2 1.0.0 (OGC 21-065r2), and its released grammar, `cql2.bnf` at tag `cql2-1.0.0` of
// github.com/opengeospatial/ogcapi-features: each case names its rule.
describe("the grammar's identifiers (BNF `identifier`, `identifierStart`, `identifierPart`)", () => {
  it.each([
    ["F_CODE", "A-Z, _ and digits after the start"],
    ["strasse.klasse", "\".\" is an identifierPart"],
    ["ns:attr", "\":\" is an identifierStart"],
    [":x", "a colon may start"],
    ["_a", "an underscore may start"],
    ["straße", "\u00DF is in \u00D8-\u00F6"],
    ["Ελλάδα", "Greek is in \u037F-\u1FFE"],
    ["东京", "CJK is in \u3001-\uD7FF"],
    ["e\u0301", "a combining mark (\u0300-\u036F) after the start"],
    ["a\u203Fb", "\u203F is an identifierPart"],
  ])("accepts %s (%s)", (name) => {
    expect(isIdentifier(name)).toBe(true);
  });

  it.each([
    ["my field", "a space is neither"],
    ["1st", "a digit can't start"],
    ['a"b', "a double quote is neither"],
    ["a-b", "a hyphen is neither"],
    ["", "an identifier has a start character"],
    ["\u0301e", "a combining mark can't start"],
    ["a;b", "\";\" is neither"],
    ["\u00D7", "\u00D7 (×) falls between the Latin-1 ranges"],
  ])("refuses %j (%s)", (name) => {
    expect(isIdentifier(name)).toBe(false);
  });
});

describe("the standard's keywords are quoted, other names are not (`propertyName = identifier | \"\\\"\" identifier \"\\\"\"`)", () => {
  const KEYWORDS = [
    "A_CONTAINEDBY", "A_CONTAINS", "A_EQUALS", "A_OVERLAPS", "ACCENTI", "AND", "BBOX", "BETWEEN", "CASEI", "DATE", "DIV",
    "FALSE", "GEOMETRYCOLLECTION", "IN", "INTERVAL", "IS", "LIKE", "LINESTRING", "MULTILINESTRING", "MULTIPOINT",
    "MULTIPOLYGON", "NOT", "NULL", "OR", "POINT", "POLYGON", "S_CONTAINS", "S_CROSSES", "S_DISJOINT", "S_EQUALS",
    "S_INTERSECTS", "S_OVERLAPS", "S_TOUCHES", "S_WITHIN", "T_AFTER", "T_BEFORE", "T_CONTAINS", "T_DISJOINT", "T_DURING",
    "T_EQUALS", "T_FINISHEDBY", "T_FINISHES", "T_INTERSECTS", "T_MEETS", "T_METBY", "T_OVERLAPPEDBY", "T_OVERLAPS",
    "T_STARTEDBY", "T_STARTS", "TIMESTAMP", "TRUE",
  ];

  it("all 51, in any case, wherever a property appears", () => {
    expect(KEYWORDS).toHaveLength(51);
    for (const k of KEYWORDS) {
      expect(toText(eq(k, 1))).toBe(`"${k}" = 1`);
      expect(toText(eq(k.toLowerCase(), 1))).toBe(`"${k.toLowerCase()}" = 1`);
    }
    expect(toText({ op: "isNull", args: [p("null")] })).toBe('"null" IS NULL');
    // The standard's examples quote "value" too, but only by choice: it isn't a keyword.
    expect(toText({ op: "isNull", args: [p("value")] })).toBe("value IS NULL");
    expect(toText({ op: "like", args: [casei(p("like")), "x"] })).toBe('CASEI("like") LIKE \'x\'');
  });

  it("not a name that only contains one", () => {
    expect(toText(eq("pointer", 1))).toBe("pointer = 1");
    expect(toText(eq("name", 1))).toBe("name = 1");
  });
});

describe("what CQL2-text can't express is refused, never written loosely", () => {
  it("a property name that isn't an identifier", () => {
    for (const property of ["my field", "1st", 'a"b']) {
      const filter = eq(property, 1);
      expect(textProblem(filter)).toEqual({ problem: "property-name", path: "/args/0" });
      expect(() => toText(filter)).toThrow(
        expect.objectContaining({ code: "not-expressible", path: "/args/0", details: { problem: "property-name" } }),
      );
    }
    expect(textProblem({ op: "in", args: [casei(p("my field")), ["x"]] })).toEqual({ problem: "property-name", path: "/args/0/args/0" });
  });

  it("a backslash in a string (Requirement 21: it escapes in every literal; no escape for itself)", () => {
    const refused: [Cql2Filter, string][] = [
      [eq("p", "C:\\temp"), "/args/1"],
      [eq("p", "back\\"), "/args/1"],
      [eq("p", "a\\'b"), "/args/1"],
      [{ op: "like", args: [p("p"), "C:\\x%"] }, "/args/1"],
      [{ op: "like", args: [p("p"), "end\\"] }, "/args/1"],
      [{ op: "like", args: [p("p"), "\\\\%"] }, "/args/1"],
      [{ op: "in", args: [p("p"), ["ok", "C:\\x"]] }, "/args/1/1"],
      [{ op: "=", args: [p("p"), casei("a\\b")] }, "/args/1/args/0"],
      [{ op: "and", args: [eq("q", 1), { op: "<>", args: [p("p"), "x\\y"] }] }, "/args/1/args/1"],
    ];
    for (const [filter, path] of refused) {
      expect(textProblem(filter)).toEqual({ problem: "backslash", path });
      expect(() => toText(filter)).toThrow(expect.objectContaining({ code: "not-expressible", path }));
    }
  });

  it("but not a LIKE pattern's own escapes, \\% and \\_ (like-predicate K)", () => {
    expect(textProblem({ op: "like", args: [p("p"), "100\\%"] })).toBeUndefined();
    expect(textProblem({ op: "like", args: [casei(p("p")), casei("a\\_b%")] })).toBeUndefined();
    // Outside LIKE, the same characters are an ordinary string with a backslash.
    expect(textProblem(eq("p", "100\\%"))).toEqual({ problem: "backslash", path: "/args/1" });
  });

  it("nothing else: quotes, wildcards, control characters typed as data", () => {
    expect(textProblem(eq("p", "O'Brien"))).toBeUndefined();
    expect(textProblem({ op: "like", args: [p("p"), "100%_"] })).toBeUndefined();
    expect(textProblem(eq("p", "tab\there"))).toBeUndefined();
  });
});

describe("literals", () => {
  it("numbers: the exponent with the grammar's uppercase E (`scientificNumericLiteral = mantissa \"E\" exponent`)", () => {
    expect(toText(eq("a", 1e21))).toBe("a = 1E+21");
    expect(toText({ op: "<", args: [p("a"), 1.5e-7] })).toBe("a < 1.5E-7");
    expect(toText({ op: ">", args: [p("a"), -2.5e-10] })).toBe("a > -2.5E-10");
    expect(toText(eq("a", 12.5))).toBe("a = 12.5");
    expect(toText({ op: "between", args: [p("a"), 1e-7, 1e21] })).toBe("a BETWEEN 1E-7 AND 1E+21");
  });

  it("strings: quoteString doubles each quote (`characterLiteral`, `escapeQuote`)", () => {
    expect(quoteString("Rhine")).toBe("'Rhine'");
    expect(quoteString("it's")).toBe("'it''s'");
    expect(quoteString("")).toBe("''");
  });
});
