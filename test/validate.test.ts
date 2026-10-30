/**
 * `validate`: what the profile accepts, what it refuses and with which code and path, and agreement with the official
 * JSON Schema (everything accepted is schema-valid; everything refused as malformed is schema-invalid).
 */
import { describe, expect, it } from "vitest";
import { CONFORMANCE, OTHER_CONFORMANCE } from "ogc-cql2";
import { assertValid, filterProperties, requiredConformance, validate, type ProblemCode } from "ogc-cql2/validate";
import { schemaAccepts } from "./schema.ts";

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });

const accepted: [string, unknown][] = [
  ["true", true],
  ["false", false],
  ["=", { op: "=", args: [p("city"), "Toronto"] }],
  ["<>", { op: "<>", args: [p("a"), 1] }],
  ["<", { op: "<", args: [p("a"), -2.5] }],
  ["<=", { op: "<=", args: [p("a"), 1e21] }],
  [">", { op: ">", args: [p("a"), 0] }],
  [">=", { op: ">=", args: [p("updated"), { date: "1970-01-01" }] }],
  ["= boolean", { op: "=", args: [p("pool"), true] }],
  ["= timestamp", { op: "=", args: [p("t"), { timestamp: "2026-10-30T12:00:00Z" }] }],
  ["timestamp with fraction", { op: "<", args: [p("t"), { timestamp: "2021-06-30T12:00:00.500Z" }] }],
  ["leap day", { op: "=", args: [p("d"), { date: "2024-02-29" }] }],
  ["leap second", { op: "=", args: [p("t"), { timestamp: "2016-12-31T23:59:60Z" }] }],
  ["isNull", { op: "isNull", args: [p("geometry")] }],
  ["not isNull", { op: "not", args: [{ op: "isNull", args: [p("geometry")] }] }],
  ["like", { op: "like", args: [p("name"), "Smith%"] }],
  ["like, escaped wildcard", { op: "like", args: [p("code"), "100\\%"] }],
  ["like, casei both", { op: "like", args: [casei(p("name")), casei("%calcutta%")] }],
  ["like, casei pattern only", { op: "like", args: [p("name"), casei("FOO%")] }],
  ["between", { op: "between", args: [p("depth"), 100.0, 150.0] }],
  ["in strings", { op: "in", args: [p("city"), ["Toronto", "Frankfurt"]] }],
  ["in numbers", { op: "in", args: [p("category"), [1, 2, 3]] }],
  ["in dates", { op: "in", args: [p("d"), [{ date: "2022-04-14" }, { date: "2022-04-15" }]] }],
  ["in casei", { op: "in", args: [casei(p("road_class")), [casei("Οδος"), casei("Straße")]] }],
  ["= casei", { op: "=", args: [casei(p("owner")), casei("somebody else")] }],
  ["and", { op: "and", args: [{ op: ">", args: [p("floors"), 5] }, { op: "=", args: [p("pool"), true] }] }],
  ["or of three", { op: "or", args: [true, false, { op: "isNull", args: [p("x")] }] }],
  ["nested", { op: "not", args: [{ op: "or", args: [{ op: "in", args: [p("a"), ["x"]] }, { op: "like", args: [p("b"), "_%"] }] }] }],
  ["extra keys are ignored", { op: "=", args: [p("a"), 1], comment: "the schema allows them" }],
];

const refused: [string, unknown, ProblemCode, string][] = [
  ["null", null, "not-an-expression", ""],
  ["a string", "a = 1", "not-an-expression", ""],
  ["a property alone", p("a"), "not-an-expression", ""],
  ["no args", { op: "=" }, "wrong-arguments", ""],
  ["casei alone", casei(p("a")), "not-an-expression", ""],
  ["arithmetic alone", { op: "+", args: [1, 2] }, "not-an-expression", ""],
  ["FilterSpec's shape", { op: "eq", property: "a", value: 1 }, "wrong-arguments", ""],
  ["a custom function", { op: "eq", args: [p("a"), 1] }, "unknown-operator", ""],
  ["and of one", { op: "and", args: [true] }, "wrong-arguments", "/args"],
  ["not of two", { op: "not", args: [true, false] }, "wrong-arguments", "/args"],
  ["= of three", { op: "=", args: [p("a"), 1, 2] }, "wrong-arguments", "/args"],
  ["property not a string", { op: "=", args: [{ property: 1 }, 1] }, "wrong-arguments", "/args/0/property"],
  ["literal on the left", { op: "=", args: ["Toronto", p("city")] }, "outside-profile", "/args/0"],
  ["property on the right", { op: "=", args: [p("a"), p("b")] }, "outside-profile", "/args/1"],
  ["function on the left", { op: "=", args: [{ op: "upper", args: [p("a")] }, "X"] }, "outside-profile", "/args/0"],
  ["arithmetic on the right", { op: ">", args: [p("a"), { op: "+", args: [1, 2] }] }, "outside-profile", "/args/1"],
  ["accenti", { op: "=", args: [{ op: "accenti", args: [p("a")] }, "é"] }, "outside-profile", "/args/0"],
  ["nested casei", { op: "=", args: [casei(casei(p("a"))), "x"] }, "outside-profile", "/args/0/args/0"],
  ["spatial", { op: "s_intersects", args: [p("geometry"), { type: "Point", coordinates: [0, 0] }] }, "outside-profile", ""],
  ["temporal", { op: "t_after", args: [p("t"), { timestamp: "2020-01-01T00:00:00Z" }] }, "outside-profile", ""],
  ["array", { op: "a_contains", args: [p("tags"), ["a"]] }, "outside-profile", ""],
  ["an interval operand", { op: "=", args: [p("t"), { interval: ["2020-01-01", ".."] }] }, "outside-profile", "/args/1"],
  ["an array operand", { op: "=", args: [p("t"), ["a"]] }, "outside-profile", "/args/1"],
  ["isNull of a literal", { op: "isNull", args: ["a"] }, "outside-profile", "/args/0"],
  ["casei = number", { op: "=", args: [casei(p("a")), 1] }, "type-mismatch", "/args/1"],
  ["casei of a number", { op: "=", args: [p("a"), casei(1)] }, "type-mismatch", "/args/1/args/0"],
  ["like a number", { op: "like", args: [p("a"), 1] }, "type-mismatch", "/args/1"],
  ["between strings", { op: "between", args: [p("a"), "a", "z"] }, "type-mismatch", "/args/1"],
  ["between casei", { op: "between", args: [casei(p("a")), 1, 2] }, "type-mismatch", "/args/0"],
  ["between two args", { op: "between", args: [p("a"), 1] }, "wrong-arguments", "/args"],
  ["in, no list", { op: "in", args: [p("a"), "x"] }, "wrong-arguments", "/args/1"],
  ["in, empty list", { op: "in", args: [p("a"), []] }, "empty-list", "/args/1"],
  ["in, mixed list", { op: "in", args: [p("a"), [1, "1"]] }, "mixed-list", "/args/1"],
  ["in, casei and numbers", { op: "in", args: [casei(p("a")), [1, 2]] }, "type-mismatch", "/args/1"],
  ["in, a null", { op: "in", args: [p("a"), ["x", null]] }, "wrong-arguments", "/args/1/1"],
  ["NaN", { op: "=", args: [p("a"), Number.NaN] }, "invalid-number", "/args/1"],
  ["date with a time", { op: "=", args: [p("d"), { date: "2020-01-01T00:00:00Z" }] }, "invalid-date", "/args/1/date"],
  ["30 February", { op: "=", args: [p("d"), { date: "2026-02-30" }] }, "invalid-date", "/args/1/date"],
  ["not a leap year", { op: "=", args: [p("d"), { date: "2100-02-29" }] }, "invalid-date", "/args/1/date"],
  ["timestamp without Z", { op: "=", args: [p("t"), { timestamp: "2023-01-01T00:00:00" }] }, "invalid-timestamp", "/args/1/timestamp"],
  ["timestamp with a space", { op: "=", args: [p("t"), { timestamp: "2023-01-01 00:00:00Z" }] }, "invalid-timestamp", "/args/1/timestamp"],
  ["hour 24", { op: "=", args: [p("t"), { timestamp: "2023-01-01T24:00:00Z" }] }, "invalid-timestamp", "/args/1/timestamp"],
  ["deep path", { op: "and", args: [true, { op: "not", args: [{ op: "=", args: [p("a"), { date: "x" }] }] }] }, "invalid-date", "/args/1/args/0/args/1/date"],
];

describe("validate accepts the profile", () => {
  it.each(accepted)("%s", (_, filter) => {
    expect(validate(filter)).toEqual({ valid: true, filter });
    expect(schemaAccepts(filter), "the official schema must accept it too").toBe(true);
  });
});

describe("validate refuses, with a code and where", () => {
  it.each(refused)("%s → %s at %j", (_, filter, code, path) => {
    const result = validate(filter);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems[0]).toMatchObject({ code, path });
    expect(result.problems[0]!.message.length).toBeGreaterThan(10);
  });

  // The schema can't tell a custom function from a typo, and has no calendar or list-type checks, so only the
  // structural refusals are compared with it.
  const structural = new Set<ProblemCode>(["not-an-expression", "wrong-arguments"]);
  it.each(refused.filter(([, filter, code]) => structural.has(code) && JSON.stringify(filter) !== undefined))(
    "the official schema refuses it too: %s",
    (_, filter) => {
      expect(schemaAccepts(filter)).toBe(false);
    },
  );

  it("names the class that outside-profile CQL2 needs", () => {
    const result = validate({ op: "s_intersects", args: [p("geometry"), { bbox: [0, 0, 1, 1] }] });
    expect(result.valid || result.problems[0]!.conformance).toBe(OTHER_CONFORMANCE.basicSpatial);
    const pp = validate({ op: "=", args: [p("a"), p("b")] });
    expect(pp.valid || pp.problems[0]!.conformance).toBe(OTHER_CONFORMANCE.propertyProperty);
  });

  it("a null says how to test for a missing value instead", () => {
    for (const [filter, path] of [
      [{ op: "=", args: [p("a"), null] }, "/args/1"],
      [{ op: "in", args: [p("a"), ["x", null]] }, "/args/1/1"],
    ] as const) {
      const result = validate(filter);
      expect(result.valid || result.problems[0]).toMatchObject({ code: "wrong-arguments", path });
      expect(result.valid || result.problems[0]!.message).toMatch(/^null is not a CQL2 literal\. .*isNull/);
    }
  });

  it("reports every problem, not just the first", () => {
    const result = validate({ op: "and", args: [{ op: "=", args: [p("a"), Number.NaN] }, { op: "in", args: [p("b"), []] }] });
    expect(result.valid ? [] : result.problems.map((x) => x.code)).toEqual(["invalid-number", "empty-list"]);
  });
});

describe("conformance", () => {
  const like = { op: "like", args: [casei(p("name")), casei("riv%")] };

  it("requiredConformance lists the profile's classes a filter uses", () => {
    expect(requiredConformance(true)).toEqual([CONFORMANCE.basic]);
    expect(requiredConformance({ op: "=", args: [p("a"), 1] })).toEqual([CONFORMANCE.basic]);
    expect(requiredConformance({ op: "not", args: [{ op: "in", args: [p("a"), [1]] }] })).toEqual([
      CONFORMANCE.basic,
      CONFORMANCE.advancedComparison,
    ]);
    expect(requiredConformance(assertValid(like))).toEqual([
      CONFORMANCE.basic,
      CONFORMANCE.advancedComparison,
      CONFORMANCE.caseInsensitive,
    ]);
  });

  it("options.conformance: a class the server doesn't declare is a problem", () => {
    const basicOnly = { conformance: [CONFORMANCE.basic] };
    expect(validate({ op: "=", args: [p("a"), 1] }, basicOnly).valid).toBe(true);
    const result = validate(like, basicOnly);
    expect(result.valid ? [] : result.problems.map((x) => [x.code, x.path, x.conformance])).toEqual([
      ["needs-conformance", "", CONFORMANCE.advancedComparison],
      ["needs-conformance", "/args/0", CONFORMANCE.caseInsensitive],
      ["needs-conformance", "/args/1", CONFORMANCE.caseInsensitive],
    ]);
  });
});

describe("filterProperties", () => {
  it("lists each property once, in order of first appearance, at any depth and inside casei", () => {
    const filter = assertValid({
      op: "and",
      args: [
        { op: "like", args: [casei(p("name")), casei("s%")] },
        { op: "not", args: [{ op: "or", args: [{ op: "in", args: [p("country"), ["CA"]] }, { op: "isNull", args: [p("name")] }] }] },
        { op: "between", args: [p("pop"), 1, 2] },
      ],
    });
    expect(filterProperties(filter)).toEqual(["name", "country", "pop"]);
    expect(filterProperties(true)).toEqual([]);
  });

  it("never mistakes a literal for a property", () => {
    expect(filterProperties(assertValid({ op: "=", args: [p("a"), "property"] }))).toEqual(["a"]);
  });
});

describe("assertValid", () => {
  it("returns the filter, or throws Cql2Error invalid-filter with the first problem's path and all problems", () => {
    expect(assertValid(true)).toBe(true);
    try {
      assertValid({ op: "=", args: [p("a"), { date: "2026-13-01" }] });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ name: "Cql2Error", code: "invalid-filter", path: "/args/1/date" });
      expect((error as { details: { problems: unknown[] } }).details.problems).toHaveLength(1);
    }
  });
});
