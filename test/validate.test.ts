/**
 * `validate`: what the profile accepts, what it refuses and with which code and path, and agreement with the official
 * JSON Schema (everything accepted is schema-valid; everything refused as malformed is schema-invalid).
 */
import { describe, expect, it } from "vitest";
import { CONFORMANCE, CQL2_CONFORMANCE } from "ogc-cql2";
import { assertValid, filterProperties, requiredConformance, validate, type ProblemCode } from "ogc-cql2/validate";
import { schemaAccepts } from "./schema.ts";
import { generateFilters } from "./corpus.ts";
import { FILTERS, RELATION_FILTERS } from "./spatial-cases.ts";

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const accenti = (arg: unknown) => ({ op: "accenti", args: [arg] });

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
  ["= accenti", { op: "=", args: [accenti(p("etat_vol")), accenti("débárquér")] }],
  ["casei of accenti, both sides", { op: "=", args: [casei(accenti(p("n"))), casei(accenti("São"))] }],
  ["accenti of casei, both sides", { op: "=", args: [accenti(casei(p("n"))), accenti(casei("São"))] }],
  ["like, accenti", { op: "like", args: [accenti(p("n")), accenti("Sao%")] }],
  ["in, accenti", { op: "in", args: [accenti(p("n")), [accenti("Bogotá"), accenti("Medellín")]] }],
  ["accenti literal against a plain property", { op: "=", args: [p("n"), accenti("São")] }],
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
  ["accenti inside accenti", { op: "=", args: [{ op: "accenti", args: [{ op: "accenti", args: [p("a")] }] }, "é"] }, "outside-profile", "/args/0/args/0"],
  ["accenti of a number", { op: "=", args: [p("a"), { op: "accenti", args: [5] }] }, "type-mismatch", "/args/1/args/0"],
  ["nested casei", { op: "=", args: [casei(casei(p("a"))), "x"] }, "outside-profile", "/args/0/args/0"],
  // The standard's conformance test (/conf/basic-spatial-functions/spatial-predicate): a latitude of 180 must fail.
  ["POINT(90 180)", { op: "s_intersects", args: [p("geometry"), { type: "Point", coordinates: [90, 180] }] }, "invalid-geometry", "/args/1/coordinates/1"],
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
  ["a leap second: no engine can compare it", { op: "=", args: [p("t"), { timestamp: "2016-12-31T23:59:60Z" }] }, "invalid-timestamp", "/args/1/timestamp"],
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
    const result = validate({ op: "t_after", args: [p("built"), { timestamp: "2020-01-01T00:00:00Z" }] });
    expect(result.valid || result.problems[0]!.conformance).toBe(CQL2_CONFORMANCE.temporal);
    const pp = validate({ op: "=", args: [p("a"), p("b")] });
    expect(pp.valid || pp.problems[0]!.conformance).toBe(CQL2_CONFORMANCE.propertyProperty);
  });

  it("names the right spatial class: points and boxes are basic; other geometries need the plus class", () => {
    const g = (literal: unknown, op = "s_intersects") => requiredConformance(assertValid({ op, args: [p("geometry"), literal] })).at(-1);
    expect(g({ type: "Point", coordinates: [1, 2] })).toBe(CONFORMANCE.basicSpatial);
    expect(g({ bbox: [0, 0, 1, 1] })).toBe(CONFORMANCE.basicSpatial);
    expect(g({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })).toBe(CONFORMANCE.basicSpatialPlus);
    expect(g({ type: "LineString", coordinates: [[0, 0], [1, 1]] })).toBe(CONFORMANCE.basicSpatialPlus);
    expect(g({ type: "Point", coordinates: [1, 2] }, "s_within")).toBe(CONFORMANCE.spatial);
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

  it("requiredConformance and options.conformance know Accent-insensitive Comparison", () => {
    const filter = { op: "=", args: [casei(accenti(p("n"))), casei(accenti("São"))] };
    expect(requiredConformance(assertValid(filter))).toEqual([CONFORMANCE.basic, CONFORMANCE.caseInsensitive, CONFORMANCE.accentInsensitive]);
    const result = validate(filter, { conformance: [CONFORMANCE.basic, CONFORMANCE.caseInsensitive] });
    expect(result.valid ? [] : result.problems.map(({ code, path, conformance }) => [code, path, conformance])).toEqual([
      ["needs-conformance", "/args/0/args/0", CONFORMANCE.accentInsensitive],
      ["needs-conformance", "/args/1/args/0", CONFORMANCE.accentInsensitive],
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

  it("CQL2_CONFORMANCE: the standard's twelve filter classes (21-065r2, Annex A), not the two encodings", () => {
    const conf = "http://www.opengis.net/spec/cql2/1.0/conf/";
    expect(Object.values(CQL2_CONFORMANCE).sort()).toEqual([
      "basic-cql2", "advanced-comparison-operators", "case-insensitive-comparison", "accent-insensitive-comparison",
      "basic-spatial-functions", "basic-spatial-functions-plus", "spatial-functions", "temporal-functions",
      "array-functions", "property-property", "functions", "arithmetic",
    ].map((name) => conf + name).sort());
  });

  it("CONFORMANCE: each implemented class is CQL2_CONFORMANCE's under the same key", () => {
    for (const [key, uri] of Object.entries(CONFORMANCE)) expect(uri, key).toBe(CQL2_CONFORMANCE[key as keyof typeof CQL2_CONFORMANCE]);
  });

  it("requiredConformance only ever names implemented classes", () => {
    const implemented = new Set<string>(Object.values(CONFORMANCE));
    for (const filter of [...generateFilters(["s", "n"]), ...FILTERS, ...RELATION_FILTERS]) {
      for (const uri of requiredConformance(filter)) expect(implemented.has(uri), uri).toBe(true);
    }
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

describe("spatial filters", () => {
  const point = (coordinates: unknown) => ({ type: "Point", coordinates });
  const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
  const geometries: [string, unknown][] = [
    ["Point", point([7.02, 49.92])],
    ["Point with a height", point([7.02, 49.92, 300])],
    ["LineString", { type: "LineString", coordinates: [[0, 0], [1, 1]] }],
    ["Polygon with a hole", { type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] }],
    ["MultiPoint", { type: "MultiPoint", coordinates: [[0, 0], [1, 1]] }],
    ["MultiLineString", { type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }],
    ["MultiPolygon", { type: "MultiPolygon", coordinates: [[ring], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] }],
    ["GeometryCollection", { type: "GeometryCollection", geometries: [point([0, 0]), { type: "LineString", coordinates: [[0, 0], [1, 1]] }] }],
    ["bbox", { bbox: [0, 40, 10, 50] }],
    ["bbox across the antimeridian", { bbox: [150, -90, -150, 90] }],
    ["bbox with heights", { bbox: [-128.1, -1.1, -99999, 180, 90, 100000] }],
    ["the extremes", { type: "LineString", coordinates: [[-180, -90], [180, 90]] }],
  ];

  it.each(geometries)("accepts %s, and the official schema does too", (_, literal) => {
    const filter = { op: "s_intersects", args: [p("geometry"), literal] };
    expect(validate(filter)).toEqual({ valid: true, filter });
    expect(schemaAccepts(filter)).toBe(true);
  });

  it.each(["s_intersects", "s_equals", "s_disjoint", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"])("accepts %s", (op) => {
    expect(validate({ op, args: [p("geometry"), { bbox: [0, 0, 1, 1] }] }).valid).toBe(true);
  });

  const problems = (literal: unknown, op = "s_intersects") => {
    const result = validate({ op, args: [p("geometry"), literal] });
    return result.valid ? [] : result.problems.map(({ code, path }) => `${code} ${path}`);
  };

  it.each([
    ["longitude out of range", point([181, 0]), "invalid-geometry /args/1/coordinates/0"],
    ["latitude out of range", point([0, -90.5]), "invalid-geometry /args/1/coordinates/1"],
    ["a position of one number", point([1]), "invalid-geometry /args/1/coordinates"],
    ["a position of four numbers", point([1, 2, 3, 4]), "invalid-geometry /args/1/coordinates"],
    ["a position that isn't numbers", point(["1", 2]), "invalid-geometry /args/1/coordinates"],
    ["a LineString of one position", { type: "LineString", coordinates: [[0, 0]] }, "invalid-geometry /args/1/coordinates"],
    ["a ring not closed", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, "invalid-geometry /args/1/coordinates/0/3"],
    ["a ring too short", { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 0]]] }, "invalid-geometry /args/1/coordinates/0"],
    ["a hole out of range", { type: "Polygon", coordinates: [ring, [[0, 0], [1, 0], [1, 95], [0, 0]]] }, "invalid-geometry /args/1/coordinates/1/2/1"],
    ["a collection of one", { type: "GeometryCollection", geometries: [point([0, 0])] }, "invalid-geometry /args/1/geometries"],
    ["a collection inside a collection", { type: "GeometryCollection", geometries: [point([0, 0]), { type: "GeometryCollection", geometries: [point([0, 0]), point([1, 1])] }] }, "invalid-geometry /args/1/geometries/1"],
    ["an unknown geometry type", { type: "Circle", coordinates: [0, 0] }, "invalid-geometry /args/1/type"],
    // GeoJSON allows a geometry's own bbox; CQL2's schema doesn't (geometry and bbox literal at once: oneOf fails).
    ["a geometry with its own GeoJSON bbox", { type: "Point", coordinates: [1, 2], bbox: [1, 2, 1, 2] }, "invalid-geometry /args/1/bbox"],
    ["a bbox of 5 numbers", { bbox: [0, 0, 1, 1, 1] }, "invalid-geometry /args/1/bbox"],
    ["a bbox with south above north", { bbox: [0, 50, 10, 40] }, "invalid-geometry /args/1/bbox"],
    ["a bbox with min height above max", { bbox: [0, 0, 100, 1, 1, 50] }, "invalid-geometry /args/1/bbox"],
    ["a bbox out of range", { bbox: [-200, 0, 10, 10] }, "invalid-geometry /args/1/bbox/0"],
  ])("refuses %s", (_, literal, problem) => {
    expect(problems(literal)).toEqual([problem]);
  });

  it("the literal second; a property-property comparison and functions are outside the profile", () => {
    const first = validate({ op: "s_equals", args: [point([1, 2]), p("geometry")] });
    expect(first.valid ? [] : first.problems.map(({ code, path, conformance }) => [code, path, conformance])).toEqual([["outside-profile", "/args/0", undefined]]);
    expect(problems(p("other"))).toEqual(["outside-profile /args/1"]);
    const buffer = validate({ op: "s_within", args: [p("road"), { op: "Buffer", args: [p("geometry"), 10, "m"] }] });
    expect(buffer.valid || buffer.problems[0]!.conformance).toBe(CQL2_CONFORMANCE.functions);
    expect(validate({ op: "=", args: [p("a"), point([1, 2])] }).valid).toBe(false); // a geometry in a comparison
  });

  it("names the class a server must declare", () => {
    const declared = [CONFORMANCE.basic, CONFORMANCE.basicSpatial];
    const check = (literal: unknown, op = "s_intersects") => {
      const result = validate({ op, args: [p("geometry"), literal] }, { conformance: declared });
      return result.valid ? "ok" : result.problems.map((x) => x.conformance).join();
    };
    expect(check({ bbox: [0, 0, 1, 1] })).toBe("ok");
    expect(check(point([1, 2]))).toBe("ok");
    expect(check({ type: "Polygon", coordinates: [ring] })).toBe(CONFORMANCE.basicSpatialPlus);
    expect(check(point([1, 2]), "s_within")).toBe(CONFORMANCE.spatial);
  });

  it("with queryables: a geometry property only, described by format or by a GeoJSON schema", () => {
    const queryables = {
      geometry: { format: "geometry-any" },
      footprint: { $ref: "https://geojson.org/schema/Polygon.json" },
      name: { type: "string" },
    };
    const check = (filter: unknown) => {
      const result = validate(filter, { queryables });
      return result.valid ? [] : result.problems.map(({ code, path }) => `${code} ${path}`);
    };
    const box = { bbox: [0, 0, 1, 1] };
    expect(check({ op: "s_intersects", args: [p("geometry"), box] })).toEqual([]);
    expect(check({ op: "s_intersects", args: [p("footprint"), box] })).toEqual([]);
    expect(check({ op: "s_intersects", args: [p("name"), box] })).toEqual(["type-mismatch /args/0"]);
    expect(check({ op: "=", args: [p("geometry"), "x"] })).toEqual(["type-mismatch /args/1"]);
    expect(check({ op: "isNull", args: [p("geometry")] })).toEqual([]);
  });
});

describe("options.queryables: types from the queryables (/per/basic-cql2/type-casts)", () => {
  // A queryables response's `properties`, as OGC API Features Part 3 serves them: extra keys are ignored.
  const queryables = {
    name: { type: "string", title: "Name" },
    day: { type: "string", format: "date" },
    at: { type: "string", format: "date-time" },
    pop: { type: "integer" },
    ratio: { type: "number" },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    geometry: { format: "geometry-point" },
    loose: { description: "no type: any literal" },
  };
  const problems = (filter: unknown) => {
    const result = validate(filter, { queryables });
    return result.valid ? [] : result.problems.map(({ code, path }) => `${code} ${path}`);
  };
  const literals: Record<string, unknown> = {
    string: "5", number: 5, boolean: true, date: { date: "2020-07-26" }, timestamp: { timestamp: "2020-07-26T12:00:00Z" },
  };
  const accepts: Record<string, string[]> = {
    name: ["string"], day: ["date"], at: ["timestamp"], pop: ["number"], ratio: ["number"], active: ["boolean"],
    tags: [], geometry: [], loose: Object.keys(literals),
  };

  it("a comparison accepts exactly the literals of the property's type", () => {
    for (const [property, ok] of Object.entries(accepts)) {
      for (const [kind, literal] of Object.entries(literals)) {
        for (const op of ["=", "<"]) {
          expect(problems({ op, args: [p(property), literal] }), `${property} ${op} ${kind}`).toEqual(
            ok.includes(kind) ? [] : ["type-mismatch /args/1"],
          );
        }
        expect(problems({ op: "in", args: [p(property), [literal]] }), `${property} in [${kind}]`).toEqual(
          ok.includes(kind) ? [] : ["type-mismatch /args/1"],
        );
      }
    }
  });

  it("says what to write instead", () => {
    const message = (filter: unknown) => (validate(filter, { queryables }) as { problems: readonly { message: string }[] }).problems[0]!.message;
    expect(message({ op: "=", args: [p("pop"), "5"] })).toBe(`"pop" is a number: compare it with a number, e.g. 5 (not "5").`);
    expect(message({ op: "=", args: [p("day"), "2020-07-26"] })).toBe(
      `"day" is a date: compare it with a date literal, e.g. { "date": "2020-07-26" }.`,
    );
    expect(message({ op: "=", args: [p("nope"), 1] })).toBe(
      `"nope" is not a queryable here. The queryables: ${Object.keys(queryables).join(", ")}.`,
    );
  });

  it("ACCENTI needs a string property too, nested or not", () => {
    expect(problems({ op: "=", args: [accenti(p("name")), accenti("x")] })).toEqual([]);
    expect(problems({ op: "=", args: [accenti(p("pop")), accenti("5")] })).toEqual(["type-mismatch /args/0/args/0"]);
    expect(problems({ op: "=", args: [casei(accenti(p("day"))), casei("x")] })).toEqual(["type-mismatch /args/0/args/0/args/0"]);
    expect(problems({ op: "=", args: [p("pop"), accenti("5")] })).toEqual(["type-mismatch /args/1"]);
    expect(problems({ op: "=", args: [accenti(p("nope")), accenti("x")] })).toEqual(["unknown-property /args/0/args/0"]);
  });

  it("LIKE and CASEI need a string property; BETWEEN a number", () => {
    expect(problems({ op: "like", args: [p("name"), "M%"] })).toEqual([]);
    expect(problems({ op: "like", args: [p("day"), "2020%"] })).toEqual(["type-mismatch /args/0"]);
    expect(problems({ op: "like", args: [casei(p("pop")), casei("5%")] })).toEqual(["type-mismatch /args/0/args/0"]);
    expect(problems({ op: "=", args: [casei(p("name")), casei("main")] })).toEqual([]);
    expect(problems({ op: "=", args: [casei(p("at")), casei("x")] })).toEqual(["type-mismatch /args/0/args/0"]);
    expect(problems({ op: "=", args: [p("name"), casei("main")] })).toEqual([]);
    expect(problems({ op: "=", args: [p("pop"), casei("5")] })).toEqual(["type-mismatch /args/1"]);
    expect(problems({ op: "between", args: [p("ratio"), 0, 1] })).toEqual([]);
    expect(problems({ op: "between", args: [p("name"), 0, 1] })).toEqual(["type-mismatch /args/0"]);
    expect(problems({ op: "between", args: [p("loose"), 0, 1] })).toEqual([]);
  });

  it("isNull accepts any queryable; an unknown property is reported wherever it is", () => {
    for (const property of Object.keys(queryables)) expect(problems({ op: "isNull", args: [p(property)] })).toEqual([]);
    expect(problems({ op: "and", args: [{ op: "isNull", args: [p("x")] }, { op: "=", args: [casei(p("y")), casei("a")] }] })).toEqual([
      "unknown-property /args/0/args/0", "unknown-property /args/1/args/0/args/0",
    ]);
    expect(problems({ op: "=", args: [p("toString"), 1] })).toEqual(["unknown-property /args/0"]);
  });

  it("problems the filter has anyway are reported once, as without queryables", () => {
    expect(problems({ op: "=", args: [casei(p("name")), 5] })).toEqual(["type-mismatch /args/1"]);
    expect(problems({ op: "between", args: [casei(p("pop")), 0, "x"] })).toEqual(["type-mismatch /args/0", "type-mismatch /args/2"]);
    expect(problems({ op: "in", args: [p("pop"), [1, "2"]] })).toEqual(["mixed-list /args/1"]);
  });

  it("a list of types, as JSON Schema allows: null is left out; several others accept any literal", () => {
    const listed = { n: { type: ["integer", "null"] }, mixed: { type: ["string", "number"] } };
    const check = (filter: unknown) => validate(filter, { queryables: listed }).valid;
    expect(check({ op: "=", args: [p("n"), 5] })).toBe(true);
    expect(check({ op: "=", args: [p("n"), "5"] })).toBe(false);
    expect(check({ op: "=", args: [p("mixed"), "5"] })).toBe(true);
  });

  it("without queryables, nothing changes", () => {
    expect(validate({ op: "=", args: [p("pop"), "5"] }).valid).toBe(true);
    expect(validate({ op: "=", args: [p("anything"), { date: "2020-07-26" }] }).valid).toBe(true);
  });
});
