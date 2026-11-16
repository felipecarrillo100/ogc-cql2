/**
 * Array Functions (OGC 21-065r2 §7.9): the standard's examples and Tests 44 / 45, the sets, what the standard leaves
 * open (decided in docs/array-research.md: a NULL or missing operand, or one that isn't an array, is NULL; a NULL
 * element is left out; elements compare as `=` does, never converted), validate's errors and classes, the text, and
 * the engines' lists.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { evaluate, evaluateConformance, toEvaluator, type Truth } from "ogc-cql2/evaluate";
import { fromText } from "ogc-cql2/parse";
import { sqlConformance, toSql } from "ogc-cql2/sql";
import { toText } from "ogc-cql2/text";
import { requiredConformance, validate } from "ogc-cql2/validate";
import { casei, generateArrayFilters, p } from "./corpus.ts";
import { schemaAccepts } from "./schema.ts";

const OPS = ["a_equals", "a_contains", "a_containedBy", "a_overlaps"] as const;
const fn = (op: string, x: unknown, y: unknown) => ({ op, args: [x, y] }) as Cql2Filter;
const t = (x: Truth) => (x === null ? "N" : x ? "T" : "F");
/** The four functions on `v` and the literal, as one code each (T, F, N), in the order of OPS. */
const four = (value: unknown, literal: unknown[], options = {}) =>
  OPS.map((op) => t(evaluate(fn(op, p("v"), literal), { properties: { v: value } }, options))).join("");
const codes = (x: unknown, options = {}) => {
  const result = validate(x, options);
  return result.valid ? [] : result.problems.map((problem) => `${problem.code} ${problem.path}`);
};

/** Timestamps as instants: the standard's text for example 82 writes `.000000Z` where its JSON writes `Z`. */
const instants = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(instants)
  : x && typeof x === "object" ? ("timestamp" in x ? Date.parse((x as { timestamp: string }).timestamp) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, instants(v)])))
  : x;

const fixture = (kind: "json" | "text", name: string) =>
  readFileSync(new URL(`./fixtures/ogc/examples/${kind}/${name}.${kind === "json" ? "json" : "txt"}`, import.meta.url), "utf8");

describe("the standard's examples", () => {
  const names = ["clause7_15", "example79", "example80", "example81", "example82"];

  it.for(names)("%s: valid, and its text reads back as its JSON", (name) => {
    const filter = JSON.parse(fixture("json", name)) as Cql2Filter;
    expect(validate(filter)).toEqual({ valid: true, filter });
    expect(instants(fromText(fixture("text", name).trim()))).toEqual(instants(filter));
    expect(fromText(toText(filter))).toEqual(filter);
  });

  it("the classes: Array Functions; 81 writes the literal first, so Property-Property too", () => {
    const portable = [CONFORMANCE.basic, CONFORMANCE.arrays];
    expect(requiredConformance(JSON.parse(fixture("json", "clause7_15")))).toEqual(portable);
    expect(requiredConformance(JSON.parse(fixture("json", "example82")))).toEqual(portable);
    expect(requiredConformance(JSON.parse(fixture("json", "example81")))).toEqual([CONFORMANCE.basic, CONFORMANCE.propertyProperty, CONFORMANCE.arrays]);
  });

  it("81 and 82 mix types in a set, and compare each element as its own kind", () => {
    const example81 = JSON.parse(fixture("json", "example81")) as Cql2Filter; // A_EQUALS(('a', TRUE, 1.0, 8), "values")
    const values = (v: unknown) => evaluate(example81, { properties: { values: v } });
    expect([values(["a", true, 1, 8]), values([8, 8, 1.0, true, "a"]), values(["a", true, 1]), values(["a", 1, 1.0, 8])]).toEqual([true, true, false, false]);
    const example82 = JSON.parse(fixture("json", "example82")) as Cql2Filter; // A_OVERLAPS("values", (TIMESTAMP(…), DATE('2010-02-10'), FALSE))
    const overlaps = (v: unknown) => evaluate(example82, { properties: { values: v } });
    expect([overlaps(["2010-02-10"]), overlaps([false]), overlaps(["2012-08-10T05:30:00Z"]), overlaps([0, "x", true])]).toEqual([true, true, true, false]);
  });
});

describe("Conformance Tests 44 and 45, on an array queryable", () => {
  const queryables = { tags: { type: "array", items: { type: "string" } } };
  const data = [["foo", "bar"], ["bar"], ["foo", "bar", "baz"], [], ["x"], null, undefined, ["bar", "foo", "foo"]];
  // As written, Test 44's ("foo","bar") are identifiers in CQL2-text: the strings are meant.
  const stored = OPS.map((op) => fn(op, p("tags"), ["foo", "bar"]));

  it("44: the four functions with ('foo', 'bar') execute, and validate against the queryables", () => {
    for (const f of stored) {
      expect(validate(f, { queryables }).valid).toBe(true);
      expect(fromText(toText(f))).toEqual(f);
    }
    const results = stored.map((f) => data.map((tags) => t(evaluate(f, { properties: { tags } }))).join(""));
    expect(results).toEqual(["TFFFFNNT", "TFTFFNNT", "TTFTFNNT", "TTTFFNNT"]);
  });

  it("45: ((NOT p1 AND p2) OR (p3 AND NOT p4) OR NOT (p1 AND p4)) is the three-valued combination of its parts", () => {
    const not = (x: Truth) => (x === null ? null : !x);
    const and = (x: Truth, y: Truth) => (x === false || y === false ? false : x === true && y === true ? true : null);
    const or = (x: Truth, y: Truth) => (x === true || y === true ? true : x === false && y === false ? false : null);
    let combinations = 0;
    for (let i = 0; i < 16; i++) {
      const [p1, p2, p3, p4] = [0, 1, 2, 3].map((k) => stored[(i + k * (1 + (i % 3))) % 4]!) as [Cql2Filter, Cql2Filter, Cql2Filter, Cql2Filter];
      const filter = {
        op: "or",
        args: [
          { op: "and", args: [{ op: "not", args: [p1] }, p2] },
          { op: "and", args: [p3, { op: "not", args: [p4] }] },
          { op: "not", args: [{ op: "and", args: [p1, p4] }] },
        ],
      } as Cql2Filter;
      expect(validate(filter, { queryables }).valid).toBe(true);
      for (const tags of data) {
        const [r1, r2, r3, r4] = [p1, p2, p3, p4].map((f) => evaluate(f, { properties: { tags } }));
        expect(evaluate(filter, { properties: { tags } })).toBe(or(or(and(not(r1!), r2!), and(r3!, not(r4!))), not(and(r1!, r4!))));
        combinations++;
      }
    }
    expect(combinations).toBe(128);
  });
});

describe("sets (Requirement 16 B and C)", () => {
  it("order and repeats don't matter; the empty set is a subset of every set, and overlaps none", () => {
    // A_EQUALS, A_CONTAINS, A_CONTAINEDBY, A_OVERLAPS against ('a', 'b')
    expect(four(["a", "b"], ["a", "b"])).toBe("TTTT");
    expect(four(["b", "a", "a"], ["a", "b"])).toBe("TTTT");
    expect(four(["a"], ["a", "b"])).toBe("FFTT");
    expect(four(["a", "b", "c"], ["a", "b"])).toBe("FTFT");
    expect(four(["a", "c"], ["a", "b"])).toBe("FFFT");
    expect(four(["c"], ["a", "b"])).toBe("FFFF");
    expect(four([], ["a", "b"])).toBe("FFTF");
    expect(four([], [])).toBe("TTTF");
    expect(four(["a"], [])).toBe("FTFF");
  });

  it("a literal first is the same function with the sets in that order", () => {
    const v = ["a", "b"];
    expect(evaluate(fn("a_containedBy", ["a"], p("v")), { properties: { v } })).toBe(true);
    expect(evaluate(fn("a_contains", ["a"], p("v")), { properties: { v } })).toBe(false);
    expect(evaluate(fn("a_equals", ["b", "a"], p("v")), { properties: { v } })).toBe(true);
  });

  it("two literals are decided once, whatever the feature", () => {
    expect(evaluate(fn("a_equals", ["a", "b"], ["b", "a", "a"]), null)).toBe(true);
    expect(evaluate(fn("a_contains", [1], [1.0]), null)).toBe(true);
    expect(evaluate(fn("a_overlaps", ["1"], [1]), null)).toBe(false);
    expect(evaluate(fn("a_containedBy", [], ["x"]), null)).toBe(true);
  });
});

describe("what the standard leaves open, decided", () => {
  it("a NULL or missing array, or a value that isn't one, is NULL, so NOT doesn't select it either", () => {
    for (const value of [null, undefined, "a", 1, { k: 1 }]) expect(four(value, ["a"])).toBe("NNNN");
    expect(evaluate({ op: "not", args: [fn("a_contains", p("v"), ["a"])] }, { properties: {} })).toBe(null);
    expect(evaluate(fn("a_contains", p("v"), ["a"]), {})).toBe(null);
  });

  it("a NULL element is left out: a set holds values", () => {
    expect(four(["a", null], ["a"])).toBe("TTTT");
    expect(four(["a", null], ["a", "b"])).toBe("FFTT");
    expect(four([null], ["a"])).toBe("FFTF");
    expect(four([null, undefined], [])).toBe("TTTF");
  });

  it("elements compare as = does: numbers by value, text exactly after NFC, booleans with booleans only", () => {
    expect(four([1.0], [1])).toBe("TTTT");
    expect(four([-0], [0])).toBe("TTTT");
    expect(four([0.1], [0.1])).toBe("TTTT");
    expect(four([true], [1])).toBe("FFFF");
    expect(four([1], [true])).toBe("FFFF");
    expect(four(["1"], [1])).toBe("FFFF");
    expect(four([1], ["1"])).toBe("FFFF");
    expect(four(["A"], ["a"])).toBe("FFFF");
    expect(four(["a "], ["a"])).toBe("FFFF");
    expect(four([""], [""])).toBe("TTTT");
    expect(four(["é"], ["é"])).toBe("TTTT"); // NFD data, NFC literal
  });

  it("a string is read as a day against a DATE, and as an instant (to the millisecond) against a TIMESTAMP", () => {
    expect(four(["2010-02-10"], [{ date: "2010-02-10" }])).toBe("TTTT");
    expect(four(["2010-02-10T00:00:00Z"], [{ date: "2010-02-10" }])).toBe("FFFF");
    expect(four(["2010-02-10T00:00:00.0004Z"], [{ timestamp: "2010-02-10T00:00:00Z" }])).toBe("TTTT");
    expect(four(["2010-02-10T05:30:00.123+00:00"], [{ timestamp: "2010-02-10T05:30:00.123Z" }])).toBe("TTTT");
    expect(four([new Date("2010-02-10T00:00:00Z")], [{ timestamp: "2010-02-10T00:00:00Z" }])).toBe("TTTT");
    expect(four(["2010-02-10"], [{ timestamp: "2010-02-10T00:00:00Z" }])).toBe("FFFF");
    expect(four(["2010-02-10"], ["2010-02-10"])).toBe("TTTT"); // as text against a string
  });

  it("an element of no scalar kind (an object, a nested array) equals nothing, but is still there", () => {
    expect(four([["a"]], ["a"])).toBe("FFFF");
    expect(four(["a", { k: 1 }], ["a"])).toBe("FTFT");
    expect(four([{ k: 1 }], [])).toBe("FTFF");
  });

  it("two array properties: by their items' kinds when the queryables say, else by the values' own types", () => {
    const pair = (x: unknown, y: unknown, queryables?: Record<string, object>) =>
      evaluate(fn("a_equals", p("x"), p("y")), { properties: { x, y } }, queryables ? { queryables } : {});
    expect(pair(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(pair(["1"], [1])).toBe(false);
    expect(pair([1], [true])).toBe(false);
    expect(pair([new Date(0)], ["1970-01-01T00:00:00Z"])).toBe(false);
    const instants = ["2010-02-10T00:00:00Z"];
    const same = ["2010-02-10T00:00:00.000Z"];
    expect(pair(instants, same)).toBe(false); // as text
    const dateTime = { type: "array", items: { type: "string", format: "date-time" } };
    expect(pair(instants, same, { x: dateTime, y: dateTime })).toBe(true); // as instants
    expect(pair(null, same)).toBe(null);
  });

  it("compiles once: one evaluator for many features", () => {
    const evaluator = toEvaluator(fn("a_overlaps", p("v"), ["a", 1]));
    expect([["a"], [1.0], ["1"], [], null].map((v) => evaluator({ properties: { v } }))).toEqual([true, true, false, false, null]);
  });
});

describe("validate", () => {
  const refused: [string, unknown, string[], object?][] = [
    ["one argument", { op: "a_contains", args: [p("v")] }, ["wrong-arguments /args"]],
    ["a single value as an operand", fn("a_contains", p("v"), "a"), ["wrong-arguments /args/1"]],
    ["a date as an operand", fn("a_contains", p("v"), { date: "2010-02-10" }), ["wrong-arguments /args/1"]],
    ["a geometry as an operand", fn("a_contains", p("v"), { type: "Point", coordinates: [0, 0] }), ["wrong-arguments /args/1"]],
    ["a function as an operand", fn("a_contains", { op: "upper", args: [p("v")] }, ["a"]), ["outside-profile /args/0"]],
    ["a null element", fn("a_contains", p("v"), ["a", null]), ["wrong-arguments /args/1/1"]],
    ["a nested array", fn("a_contains", p("v"), [["a"]]), ["outside-profile /args/1/0"]],
    ["a property inside an array", fn("a_contains", p("v"), [p("w")]), ["outside-profile /args/1/0"]],
    ["CASEI inside an array", fn("a_contains", p("v"), [casei("a")]), ["outside-profile /args/1/0"]],
    ["an interval inside an array", fn("a_contains", p("v"), [{ interval: ["2020-01-01", ".."] }]), ["outside-profile /args/1/0"]],
    ["a geometry inside an array", fn("a_contains", p("v"), [{ type: "Point", coordinates: [0, 0] }]), ["outside-profile /args/1/0"]],
    ["a function inside an array", fn("a_contains", p("v"), [{ op: "upper", args: ["a"] }]), ["outside-profile /args/1/0"]],
    ["arithmetic inside an array", fn("a_contains", p("v"), [{ op: "+", args: [1, 2] }]), ["outside-profile /args/1/0"]],
    ["a filter inside an array", fn("a_contains", p("v"), [{ op: "=", args: [p("w"), 1] }]), ["outside-profile /args/1/0"]],
    ["Infinity", fn("a_contains", p("v"), [Infinity]), ["invalid-number /args/1/0"]],
    ["a day that doesn't exist", fn("a_contains", p("v"), [{ date: "2010-02-30" }]), ["invalid-date /args/1/0/date"]],
    ["a timestamp without Z", fn("a_overlaps", p("v"), [{ timestamp: "2010-02-10T00:00:00" }]), ["invalid-timestamp /args/1/0/timestamp"]],
    ["two problems, both reported", fn("a_equals", ["a", null], [["x"]]), ["wrong-arguments /args/0/1", "outside-profile /args/1/0"]],
  ];
  it.for(refused)("refuses %s", ([, filter, expected]) => expect(codes(filter)).toEqual(expected));

  it("names the Functions class for a function inside an array, and no class for the rest", () => {
    const problem = (f: unknown) => (validate(f) as unknown as { problems: { conformance?: string }[] }).problems[0]!.conformance;
    expect(problem(fn("a_contains", p("v"), [{ op: "upper", args: ["a"] }]))).toBe("http://www.opengis.net/spec/cql2/1.0/conf/functions");
    expect(problem(fn("a_contains", p("v"), [["a"]]))).toBeUndefined();
  });

  it("with queryables: the property must be an array, and an element compared with its items of a kind they accept", () => {
    const queryables = {
      tags: { type: "array", items: { type: "string" } },
      nums: { type: ["array", "null"], items: { type: "number" } },
      days: { type: "array", items: { type: "string", format: "date" } },
      any: { type: "array" },
      name: { type: "string" },
      loose: { description: "no type" },
    };
    const check = (f: unknown) => codes(f, { queryables });
    expect(check(fn("a_contains", p("tags"), ["a", "b"]))).toEqual([]);
    expect(check(fn("a_contains", p("tags"), ["a", 1]))).toEqual(["type-mismatch /args/1/1"]);
    expect(check(fn("a_contains", [1, "a"], p("nums")))).toEqual(["type-mismatch /args/0/1"]);
    expect(check(fn("a_overlaps", p("days"), [{ date: "2010-02-10" }]))).toEqual([]);
    expect(check(fn("a_overlaps", p("days"), ["2010-02-10"]))).toEqual(["type-mismatch /args/1/0"]);
    expect(check(fn("a_equals", p("any"), ["a", 1, true]))).toEqual([]);
    expect(check(fn("a_equals", p("loose"), ["a", 1]))).toEqual([]);
    expect(check(fn("a_equals", p("tags"), p("nums")))).toEqual(["type-mismatch /args/1"]);
    expect(check(fn("a_equals", p("tags"), p("any")))).toEqual([]);
    expect(check(fn("a_contains", p("name"), ["a"]))).toEqual(["type-mismatch /args/0"]);
    expect(check(fn("a_contains", p("other"), ["a"]))).toEqual(["unknown-property /args/0"]);
  });

  it("the messages name what the array property holds, in the plural (since 1.6.2)", () => {
    const queryables = {
      tags: { type: "array", items: { type: "string" } },
      counts: { type: "array", items: { type: "integer" } },
      days: { type: "array", items: { type: "string", format: "date" } },
    };
    const messages = (f: unknown) => {
      const result = validate(f, { queryables });
      return result.valid ? [] : result.problems.map((x) => x.message);
    };
    expect(messages(fn("a_contains", p("tags"), ["a", 1]))).toEqual(['"tags" holds strings, and this is a number.']);
    expect(messages(fn("a_overlaps", p("counts"), ["5"]))).toEqual(['"counts" holds numbers, and this is a string.']);
    expect(messages(fn("a_overlaps", p("days"), ["2010-02-10"]))).toEqual(['"days" holds dates, and this is a string.']);
    expect(messages(fn("a_equals", p("tags"), p("counts")))).toEqual(['"tags" holds strings and "counts" numbers: they can\'t be compared.']);
  });

  it("the classes: Array Functions; an array first, two properties or two literals also Property-Property", () => {
    const portable = fn("a_contains", p("v"), ["a"]);
    expect(requiredConformance(portable)).toEqual([CONFORMANCE.basic, CONFORMANCE.arrays]);
    for (const f of [fn("a_contains", ["a"], p("v")), fn("a_contains", p("v"), p("w")), fn("a_contains", ["a"], ["b"])]) {
      expect(requiredConformance(f)).toEqual([CONFORMANCE.basic, CONFORMANCE.propertyProperty, CONFORMANCE.arrays]);
      expect(codes(f, { conformance: [CONFORMANCE.basic, CONFORMANCE.arrays] })).toEqual(["needs-conformance "]);
    }
    expect(codes(portable, { conformance: [CONFORMANCE.basic] })).toEqual(["needs-conformance "]);
    expect(codes({ op: "not", args: [portable] }, { conformance: [CONFORMANCE.basic, CONFORMANCE.arrays] })).toEqual([]);
  });

  it("the generated filters are valid in the official schema too", () => {
    const filters = generateArrayFilters(["tags", "n"]);
    expect(filters.length).toBeGreaterThan(500);
    expect(filters.filter((f) => !schemaAccepts(f)).map((f) => JSON.stringify(f)).slice(0, 3)).toEqual([]);
  });
});

describe("CQL2-text", () => {
  it("writes the functions in the grammar's capitals, an array in parentheses, () when empty", () => {
    expect(toText(fn("a_contains", p("tags"), ["a", "b"]))).toBe("A_CONTAINS(tags, ('a', 'b'))");
    expect(toText(fn("a_containedBy", ["a"], p("tags")))).toBe("A_CONTAINEDBY(('a'), tags)");
    expect(toText(fn("a_overlaps", p("tags"), []))).toBe("A_OVERLAPS(tags, ())");
    expect(toText(fn("a_equals", p("values"), [{ date: "2010-02-10" }, { timestamp: "2012-08-10T05:30:00Z" }, true, 1.5, "it's"]))).toBe(
      "A_EQUALS(values, (DATE('2010-02-10'), TIMESTAMP('2012-08-10T05:30:00Z'), TRUE, 1.5, 'it''s'))",
    );
  });

  it("reads ( … ) after an array function as an array, even of one element or none; [ … ] isn't CQL2 1.0", () => {
    expect(fromText("A_CONTAINS(tags, ('a'))")).toEqual(fn("a_contains", p("tags"), ["a"]));
    expect(fromText("A_CONTAINS(tags, ())")).toEqual(fn("a_contains", p("tags"), []));
    expect(() => fromText("A_CONTAINS(tags, ['a'])")).toThrow(expect.objectContaining({ code: "invalid-text" }));
  });
});

describe("the engines", () => {
  it("evaluate has the class, with or without a geometry engine", () => {
    expect(evaluateConformance()).toContain(CONFORMANCE.arrays);
    expect(evaluateConformance({ spatialEngine: { prepare: () => ({ relate: () => "FFFFFFFF2" }) } })).toContain(CONFORMANCE.arrays);
  });

  it("postgres writes it (since its phase: see test/sql-postgres.test.ts and demo-server's live test)", () => {
    expect(sqlConformance({ dialect: "postgres" })).toContain(CONFORMANCE.arrays);
    expect(toSql(fn("a_contains", p("v"), ["a"]), { dialect: "postgres", columns: { v: { sqlType: "text[]" } } }).where).toBe(
      "cql2_text_array(\"v\") @> ARRAY[$1]::text[]",
    );
  });

  it("duckdb writes it (see test/duckdb-arrays.ts, run on DuckDB 2.0 and 1.5)", () => {
    expect(sqlConformance({ dialect: "duckdb" })).toContain(CONFORMANCE.arrays);
    expect(toSql(fn("a_contains", p("v"), ["a"]), { dialect: "duckdb", columns: { v: { sqlType: "VARCHAR[]" } } }).where).toContain("list_has_all(");
  });

  it("sqlite writes it, through cql2_array (see test/sql-arrays-sqlite.test.ts)", () => {
    expect(sqlConformance({ dialect: "sqlite" })).toContain(CONFORMANCE.arrays);
    expect(toSql(fn("a_contains", p("v"), ["a"]), { dialect: "sqlite", columns: { v: { items: {} } } }).where).toBe(
      "cql2_array('a_contains', \"v\", ?, ?) = 1",
    );
  });

  it("oracle writes it, through JSON_TABLE (see test/sql-oracle.test.ts; demo-server's oracle-arrays.test.ts on Oracle)", () => {
    expect(sqlConformance({ dialect: "oracle" })).toContain(CONFORMANCE.arrays);
    expect(toSql(fn("a_contains", p("v"), ["a"]), { dialect: "oracle", columns: { v: { sqlType: "JSON", items: {} } } }).where).toContain("JSON_TABLE(");
  });

  it("sqlserver writes it, through OPENJSON (see test/sql-sqlserver.test.ts; demo-server's sqlserver-arrays.test.ts on SQL Server)", () => {
    expect(sqlConformance({ dialect: "sqlserver" })).toContain(CONFORMANCE.arrays);
    expect(toSql(fn("a_contains", p("v"), ["a"]), { dialect: "sqlserver", columns: { v: { sqlType: "nvarchar", items: {} } } }).where).toContain("OPENJSON(");
  });
});
