/**
 * `toSql`, dialect `oracle`: the SQL text and parameters per operator and column type, `oracleValue` and
 * `oracleFunctions`. Whether that SQL selects what `evaluate` selects is checked against a real Oracle Database by
 * demo-server's tests (they skip without one).
 */
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { oracleFunctions, oracleValue, toSql, type SqlColumn } from "ogc-cql2/sql";

const COLUMNS: Record<string, SqlColumn> = {
  name: { type: "string", sqlType: "VARCHAR2(100)" },
  other: { type: "string", sqlType: "VARCHAR2(100 CHAR)" },
  code: { type: "string", sqlType: "CHAR(4)" },
  national: { type: "string", sqlType: "NVARCHAR2(20)" },
  n: { type: "integer", sqlType: "NUMBER(10)" },
  amount: { type: "number", sqlType: "NUMBER(12,2)" },
  ratio: { type: "number", sqlType: "BINARY_DOUBLE" },
  geometry: { format: "geometry-any", sqlType: "SDO_GEOMETRY" },
  active: { type: "boolean", sqlType: "BOOLEAN" },
  day: { type: "string", format: "date", sqlType: "DATE" },
  stamp: { type: "string", sqlType: "DATE" },
  at: { type: "string", format: "date-time", sqlType: "TIMESTAMP(6) WITH TIME ZONE" },
  local_at: { type: "string", sqlType: "TIMESTAMP(6)" },
  plain: { type: "string" }, // no sqlType: read from the queryable
  sday: { type: "string", format: "date", sqlType: "VARCHAR2(10)" }, // days held as text
};
const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const accenti = (arg: unknown) => ({ op: "accenti", args: [arg] });
const sql = (filter: unknown, functionSchema?: string) =>
  toSql(filter as Cql2Filter, { dialect: "oracle", columns: COLUMNS, ...(functionSchema ? { functionSchema } : {}) });
const DOUBLE = (n: number) => `TO_BINARY_DOUBLE(:${n}, '9D9999999999999999EEEE', 'NLS_NUMERIC_CHARACTERS=''.,''')`;

describe("the oracle dialect", () => {
  it(":n placeholders; numbers as BINARY_DOUBLE, literals as text in one format whatever the session", () => {
    expect(sql({ op: "and", args: [{ op: ">", args: [p("n"), 5] }, { op: "=", args: [p("active"), true] }] })).toEqual({
      where: `(TO_BINARY_DOUBLE("n") > ${DOUBLE(1)}) AND ("active" = :2)`,
      params: ["5e+0", true],
    });
    expect(sql({ op: "between", args: [p("amount"), 1, 2.5] })).toEqual({
      where: `TO_BINARY_DOUBLE("amount") BETWEEN ${DOUBLE(1)} AND ${DOUBLE(2)}`,
      params: ["1e+0", "2.5e+0"],
    });
    // A BINARY_DOUBLE column as it is (it keeps its index); numbers NUMBER can't hold, as text.
    expect(sql({ op: "in", args: [p("ratio"), [1e308, 1e-320, 9007199254740991]] })).toEqual({
      where: `"ratio" IN (${DOUBLE(1)}, ${DOUBLE(2)}, ${DOUBLE(3)})`,
      params: ["1e+308", "1e-320", "9.007199254740991e+15"],
    });
  });

  it("text in code point order: COLLATE BINARY on the parameter, so the column keeps its index", () => {
    expect(sql({ op: "<", args: [p("name"), "café"] })).toEqual({ where: `"name" < :1 COLLATE BINARY`, params: ["café"] });
    expect(sql({ op: "in", args: [p("name"), ["a", "b"]] }).where).toBe(`"name" IN (:1 COLLATE BINARY, :2 COLLATE BINARY)`);
    // NVARCHAR2 as VARCHAR2 (UTF-16 would order by code units); CHAR as it is against a literal (no blank padding).
    expect(sql({ op: "=", args: [p("national"), "x"] }).where).toBe(`TO_CHAR("national") = :1 COLLATE BINARY`);
    expect(sql({ op: "=", args: [p("code"), "x"] }).where).toBe(`"code" = :1 COLLATE BINARY`);
    expect(sql({ op: "=", args: [p("plain"), "x"] }).where).toBe(`"plain" = :1 COLLATE BINARY`);
  });

  it("'' is NULL in Oracle and in no column: a comparison with it is decided here, with no parameter", () => {
    for (const op of ["=", "<", "<="]) expect(sql({ op, args: [p("name"), ""] })).toEqual({ where: `"name" <> "name"`, params: [] });
    for (const op of ["<>", ">", ">="]) expect(sql({ op, args: [p("name"), ""] })).toEqual({ where: `"name" = "name"`, params: [] });
    expect(sql({ op: "like", args: [p("name"), ""] }).where).toBe(`"name" <> "name"`);
    expect(sql({ op: "in", args: [p("name"), ["", "a"]] })).toEqual({ where: `"name" IN (:1 COLLATE BINARY)`, params: ["a"] });
    expect(sql({ op: "in", args: [p("name"), [""]] }).where).toBe(`"name" <> "name"`);
    expect(sql({ op: "=", args: [casei(p("name")), casei("")] }).where).toBe(`cql2_casei("name") <> cql2_casei("name")`);
    expect(sql({ op: ">", args: ["", p("name")] }).where).toBe(`"name" <> "name"`); // '' > name is name < ''
  });

  it("LIKE with ESCAPE '\\': an escape Oracle refuses is the character itself, a lone trailing one a backslash", () => {
    expect(sql({ op: "like", args: [p("name"), "Riv%"] })).toEqual({ where: `"name" LIKE :1 COLLATE BINARY ESCAPE '\\'`, params: ["Riv%"] });
    expect(sql({ op: "like", args: [p("name"), "100\\%"] }).params).toEqual(["100\\%"]);
    expect(sql({ op: "like", args: [p("name"), "a\\_b\\\\c"] }).params).toEqual(["a\\_b\\\\c"]);
    expect(sql({ op: "like", args: [p("name"), "\\a\\b"] }).params).toEqual(["ab"]);
    expect(sql({ op: "like", args: [p("name"), "end\\"] }).params).toEqual(["end\\\\"]);
    expect(sql({ op: "like", args: [casei(p("name")), casei("RIV%")] }).where).toBe(`cql2_casei("name") LIKE :1 COLLATE BINARY ESCAPE '\\'`);
  });

  it("CASEI and ACCENTI through the cql2_* functions, schema-qualified on request", () => {
    expect(sql({ op: "=", args: [casei(p("name")), casei("STRASSE")] })).toEqual({
      where: `cql2_casei("name") = :1 COLLATE BINARY`,
      params: ["strasse"],
    });
    expect(sql({ op: "=", args: [accenti(casei(p("name"))), "cafe"] }, "CQL2").where).toBe(
      `"CQL2".cql2_accenti("CQL2".cql2_casei("name")) = :1 COLLATE BINARY`,
    );
  });

  it("instants as UTC text truncated to milliseconds, the year in five digits; days as YYYY-MM-DD text", () => {
    expect(sql({ op: "<", args: [p("at"), { timestamp: "2023-01-01T00:00:00.5Z" }] })).toEqual({
      where: `(('0' || TO_CHAR(SYS_EXTRACT_UTC("at"), 'YYYY-MM-DD"T"HH24:MI:SS.FF3')) < :1 COLLATE BINARY AND SYS_EXTRACT_UTC("at") >= TIMESTAMP '0001-01-01 00:00:00')`,
      params: ["02023-01-01T00:00:00.500"],
    });
    // A DATE is a day only with format "date"; a year before 1 is served with its sign, so it is no day (NULL).
    expect(sql({ op: ">=", args: [p("day"), { date: "2020-07-26" }] })).toEqual({
      where: `(TO_CHAR("day", 'YYYY-MM-DD') >= :1 COLLATE BINARY AND "day" >= DATE '0001-01-01')`,
      params: ["2020-07-26"],
    });
    expect(sql({ op: "not", args: [{ op: ">=", args: [p("day"), { date: "2020-07-26" }] }] }).where).toBe(
      `NOT ((TO_CHAR("day", 'YYYY-MM-DD') >= :1 COLLATE BINARY OR NOT "day" >= DATE '0001-01-01'))`,
    );
    expect(sql({ op: "=", args: [p("name"), { date: "2020-07-26" }] }).where).toBe(`cql2_day("name") = :1 COLLATE BINARY`);
    expect(sql({ op: "=", args: [p("name"), { timestamp: "2020-07-26T00:00:00Z" }] })).toEqual({
      where: `cql2_instant("name") = :1 COLLATE BINARY`,
      params: ["02020-07-26T00:00:00.000"],
    });
    // A string literal against a date or timestamp column compares the served text.
    expect(sql({ op: "=", args: [p("at"), "2023-01-01T00:00:00.000Z"] }).where).toBe(
      `LTRIM(TO_CHAR(SYS_EXTRACT_UTC("at"), 'SYYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')) = :1 COLLATE BINARY`,
    );
    expect(sql({ op: "<", args: [p("stamp"), "2020"] }).where).toBe(`LTRIM(TO_CHAR("stamp", 'SYYYY-MM-DD"T"HH24:MI:SS')) < :1 COLLATE BINARY`);
  });

  it("a literal no value of the column can match is NULL, typed", () => {
    const never = "CAST(NULL AS BOOLEAN)";
    expect(sql({ op: "=", args: [p("n"), "5"] })).toEqual({ where: never, params: [] });
    expect(sql({ op: "=", args: [p("name"), 5] }).where).toBe(never);
    // A DATE without format "date", and a TIMESTAMP, have no zone: never instants, never days.
    expect(sql({ op: "=", args: [p("stamp"), { date: "2023-01-01" }] }).where).toBe(never);
    expect(sql({ op: "=", args: [p("stamp"), { timestamp: "2023-01-01T00:00:00Z" }] }).where).toBe(never);
    expect(sql({ op: "=", args: [p("local_at"), { timestamp: "2023-01-01T00:00:00Z" }] }).where).toBe(never);
    expect(sql({ op: "=", args: [p("at"), { date: "2023-01-01" }] }).where).toBe(never);
    expect(sql({ op: "not", args: [{ op: "=", args: [p("active"), 1] }] }).where).toBe(`NOT (${never})`);
  });

  it("isNull, true and false", () => {
    expect(sql({ op: "isNull", args: [p("day")] }).where).toBe(`"day" IS NULL`);
    expect(sql(true).where).toBe("TRUE");
    expect(sql(false).where).toBe("FALSE");
  });
});

describe("spatial relations in the oracle dialect", () => {
  const G: Record<string, SqlColumn> = {
    geometry: { format: "geometry-any", sqlType: "SDO_GEOMETRY", column: "geom" },
    indexed: { format: "geometry-any", sqlType: "SDO_GEOMETRY", spatialIndex: true },
    other: { format: "geometry-any", sqlType: "SDO_GEOMETRY" },
    name: { type: "string", sqlType: "VARCHAR2(100)" },
  };
  const s = (filter: unknown, functionSchema?: string) =>
    toSql(filter as Cql2Filter, { dialect: "oracle", columns: G, ...(functionSchema ? { functionSchema } : {}) });
  const lit = (n: number, srid = "NULL") => `(SELECT cql2_geometry(TO_CLOB(:${n}), ${srid}) FROM dual)`;
  const pt = (x: number, y: number) => ({ type: "Point", coordinates: [x, y] });

  it("through cql2_relate, the literal built once per query from its numbers (Oracle's GeoJSON keeps 15 digits)", () => {
    expect(s({ op: "s_intersects", args: [p("geometry"), pt(-179.99999999999997, 3.3499999999999996)] })).toEqual({
      where: `cql2_relate('s_intersects', "geom", ${lit(1)}) = 1`,
      params: ["2001 3 1 1 1 -1.7999999999999997e+2 3.3499999999999996e+0"],
    });
    for (const op of ["s_equals", "s_touches", "s_within", "s_overlaps", "s_crosses", "s_contains"]) {
      expect(s({ op, args: [p("geometry"), pt(1, 2)] }).where).toBe(`cql2_relate('${op}', "geom", ${lit(1)}) = 1`);
    }
    expect(s({ op: "s_disjoint", args: [p("geometry"), pt(1, 2)] }).where).toBe(`NOT (cql2_relate('s_intersects', "geom", ${lit(1)}) = 1)`);
    expect(s({ op: "s_within", args: [p("geometry"), pt(1, 2)] }, "CQL2").where).toBe(
      `"CQL2".cql2_relate('s_within', "geom", (SELECT "CQL2".cql2_geometry(TO_CLOB(:1), NULL) FROM dual)) = 1`,
    );
    // A column that holds no geometry: no value can match.
    expect(s({ op: "s_intersects", args: [p("name"), pt(1, 2)] }).where).toBe("CAST(NULL AS BOOLEAN)");
  });

  it("the literal as Oracle requires it: boxes as polygons, rings oriented, heights dropped", () => {
    const params = (literal: unknown) => s({ op: "s_intersects", args: [p("geometry"), literal] }).params;
    expect(params({ bbox: [0, 1, 2, 3] })).toEqual(["2003 3 1 1003 1 0e+0 1e+0 2e+0 1e+0 2e+0 3e+0 0e+0 3e+0 0e+0 1e+0"]);
    expect(params({ bbox: [0, 1, -5, 2, 3, 5] })).toEqual(params({ bbox: [0, 1, 2, 3] })); // a 3D box: its 2D box
    // Across the antimeridian: two boxes.
    expect(params({ bbox: [170, 0, -170, 1] })).toEqual([
      "2007 6 1 1003 1 11 1003 1 1.7e+2 0e+0 1.8e+2 0e+0 1.8e+2 1e+0 1.7e+2 1e+0 1.7e+2 0e+0 -1.8e+2 0e+0 -1.7e+2 0e+0 -1.7e+2 1e+0 -1.8e+2 1e+0 -1.8e+2 0e+0",
    ]);
    // A clockwise exterior and a counter-clockwise hole are turned around; a point's height is dropped.
    const cw = { type: "Polygon", coordinates: [[[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] };
    expect(params(cw)).toEqual([
      "2003 6 1 1003 1 11 2003 1 0e+0 0e+0 4e+0 0e+0 4e+0 4e+0 0e+0 4e+0 0e+0 0e+0 1e+0 1e+0 1e+0 2e+0 2e+0 2e+0 2e+0 1e+0 1e+0 1e+0",
    ]);
    expect(params({ type: "Point", coordinates: [1, 2, 3] })).toEqual(["2001 3 1 1 1 1e+0 2e+0"]);
    expect(params({ type: "GeometryCollection", geometries: [pt(1, 2), { type: "LineString", coordinates: [[0, 0], [1, 1]] }] })).toEqual([
      "2004 6 1 1 1 3 2 1 1e+0 2e+0 0e+0 0e+0 1e+0 1e+0",
    ]);
  });

  it("a long literal as several parameters of at most 3,900 characters (Oracle refuses a longer bound text)", () => {
    const line = { type: "LineString", coordinates: Array.from({ length: 400 }, (_, i) => [i % 170 + 0.123456789, -(i % 80) - 0.987654321]) };
    const { where, params } = s({ op: "s_intersects", args: [p("geometry"), line] });
    expect(params.length).toBeGreaterThan(3);
    expect(params.every((x) => (x as string).length <= 3900)).toBe(true);
    expect(where).toBe(`cql2_relate('s_intersects', "geom", (SELECT cql2_geometry(${params.map((_, i) => `TO_CLOB(:${i + 1})`).join(" || ")}, NULL) FROM dual)) = 1`);
  });

  it("spatialIndex: the planar index's candidates first (the literal written again), only where the leaf isn't negated", () => {
    const exact = `cql2_relate('s_within', "indexed", ${lit(2)}) = 1`;
    expect(s({ op: "s_within", args: [p("indexed"), pt(1, 2)] })).toEqual({
      // On cql2_planar(column), not the column: a 4326 index is geodetic and loses planar candidates.
      where: `(SDO_FILTER(cql2_planar("indexed"), ${lit(1)}) = 'TRUE' AND ${exact})`,
      params: ["2001 3 1 1 1 1e+0 2e+0", "2001 3 1 1 1 1e+0 2e+0"],
    });
    expect(s({ op: "not", args: [{ op: "s_within", args: [p("indexed"), pt(1, 2)] }] }).where).toBe(`NOT (cql2_relate('s_within', "indexed", ${lit(1)}) = 1)`);
    expect(s({ op: "s_disjoint", args: [p("indexed"), pt(1, 2)] }).where).toBe(`NOT (cql2_relate('s_intersects', "indexed", ${lit(1)}) = 1)`);
    expect(s({ op: "not", args: [{ op: "s_disjoint", args: [p("indexed"), pt(1, 2)] }] }).where).toContain("SDO_FILTER");
  });

  it("two columns, a literal first (the converse relation), and two literals", () => {
    expect(s({ op: "s_within", args: [p("geometry"), p("other")] }).where).toBe(`cql2_relate('s_within', "geom", "other") = 1`);
    expect(s({ op: "s_within", args: [pt(1, 2), p("geometry")] }).where).toBe(`cql2_relate('s_contains', "geom", ${lit(1)}) = 1`);
    expect(s({ op: "s_touches", args: [pt(1, 2), { bbox: [0, 0, 1, 2] }] }).where).toBe(`cql2_relate('s_touches', ${lit(1)}, ${lit(2)}) = 1`);
    expect(s({ op: "s_intersects", args: [pt(1, 2), { bbox: [0, 0, 1, 2] }] }).where).toBe("TRUE"); // decided here
  });
});

describe("Property-Property Comparisons and Temporal Functions in the oracle dialect", () => {
  it("two columns: each side's view, both with COLLATE BINARY; CHAR as VARCHAR2 (no blank-padded comparison)", () => {
    expect(sql({ op: "<", args: [p("name"), p("other")] })).toEqual({ where: `"name" COLLATE BINARY < "other" COLLATE BINARY`, params: [] });
    expect(sql({ op: "=", args: [p("code"), p("name")] }).where).toBe(`CAST("code" AS VARCHAR2(4000 BYTE)) COLLATE BINARY = "name" COLLATE BINARY`);
    expect(sql({ op: "<", args: [p("day"), p("sday")] }).where).toBe(
      `CASE WHEN "day" >= DATE '0001-01-01' THEN TO_CHAR("day", 'YYYY-MM-DD') END COLLATE BINARY < cql2_day("sday") COLLATE BINARY`,
    );
  });

  it("an interval of two columns: NULL unless both ends are values and it begins before it ends", () => {
    expect(sql({ op: "t_meets", args: [{ interval: [p("at"), p("at")] }, { interval: ["2020-01-01T00:00:00Z", ".."] }] })).toEqual({
      where: `CASE WHEN (SYS_EXTRACT_UTC("at") >= TIMESTAMP '0001-01-01 00:00:00') AND (SYS_EXTRACT_UTC("at") >= TIMESTAMP '0001-01-01 00:00:00') AND (CASE WHEN SYS_EXTRACT_UTC("at") >= TIMESTAMP '0001-01-01 00:00:00' THEN ('0' || TO_CHAR(SYS_EXTRACT_UTC("at"), 'YYYY-MM-DD"T"HH24:MI:SS.FF3')) END COLLATE BINARY <= CASE WHEN SYS_EXTRACT_UTC("at") >= TIMESTAMP '0001-01-01 00:00:00' THEN ('0' || TO_CHAR(SYS_EXTRACT_UTC("at"), 'YYYY-MM-DD"T"HH24:MI:SS.FF3')) END COLLATE BINARY) THEN ('0' || TO_CHAR(SYS_EXTRACT_UTC("at"), 'YYYY-MM-DD"T"HH24:MI:SS.FF3')) = :1 COLLATE BINARY END`,
      params: ["02020-01-01T00:00:00.000"],
    });
  });
});

describe("Arithmetic Expressions in the oracle dialect", () => {
  const op = (o: string, a: unknown, b: unknown) => ({ op: o, args: [a, b] });
  const guard = (r: string) => `NULLIF(NULLIF(NANVL(${r}, CAST(NULL AS BINARY_DOUBLE)), BINARY_DOUBLE_INFINITY), -BINARY_DOUBLE_INFINITY)`;

  it("+ - * / and div inline in BINARY_DOUBLE, a result that isn't finite NULL; % and ^ through cql2_arithmetic", () => {
    expect(sql({ op: ">", args: [op("*", p("amount"), 0.001), p("n")] })).toEqual({
      where: `${guard(`TO_BINARY_DOUBLE("amount") * ${DOUBLE(1)}`)} > TO_BINARY_DOUBLE("n")`,
      params: ["1e-3"],
    });
    expect(sql({ op: ">", args: [op("div", p("n"), 2), 1] }).where).toBe(`${guard(`TRUNC(TO_BINARY_DOUBLE("n") / ${DOUBLE(1)})`)} > ${DOUBLE(2)}`);
    expect(sql({ op: ">", args: [op("%", p("ratio"), 3), 1] }, "CQL2").where).toBe(`"CQL2".cql2_arithmetic('%', "ratio", ${DOUBLE(1)}) > ${DOUBLE(2)}`);
    expect(sql({ op: "<", args: [op("^", p("n"), 2), 9] }).where).toBe(`cql2_arithmetic('^', TO_BINARY_DOUBLE("n"), ${DOUBLE(1)}) < ${DOUBLE(2)}`);
    // Literals only: computed here.
    expect(sql({ op: ">", args: [p("n"), op("+", 1038290, op("^", 2, 3))] })).toEqual({ where: `TO_BINARY_DOUBLE("n") > ${DOUBLE(1)}`, params: ["1.038298e+6"] });
  });
});

describe("oracleValue: what the application selects, so it serves what the SQL compares", () => {
  it.for([
    ["name", `"name"`],
    ["code", `"code"`],
    ["national", `TO_CHAR("national")`],
    ["n", `TO_BINARY_DOUBLE("n")`],
    ["ratio", `"ratio"`],
    ["active", `"active"`],
    ["geometry", `"geometry"`], // the SDO_GEOMETRY object: read its ordinates, which are exact
    ["day", `LTRIM(TO_CHAR("day", 'SYYYY-MM-DD'))`],
    ["stamp", `LTRIM(TO_CHAR("stamp", 'SYYYY-MM-DD"T"HH24:MI:SS'))`],
    ["at", `LTRIM(TO_CHAR(SYS_EXTRACT_UTC("at"), 'SYYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'))`],
    ["local_at", `LTRIM(TO_CHAR("local_at", 'SYYYY-MM-DD"T"HH24:MI:SS.FF3'))`],
  ])("%s", ([name, expected]) => {
    expect(oracleValue(name!, COLUMNS[name!]!)).toBe(expected);
  });

  it("a type the dialect can't compare: undefined", () => {
    expect(oracleValue("doc", { sqlType: "CLOB" })).toBeUndefined();
    expect(oracleValue("raw", { sqlType: "RAW(16)" })).toBeUndefined();
    expect(oracleValue("tz", { sqlType: "TIMESTAMP(3) WITH LOCAL TIME ZONE" })).toBe(`LTRIM(TO_CHAR(SYS_EXTRACT_UTC("tz"), 'SYYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'))`);
  });
});

describe("oracleFunctions", () => {
  const statements = oracleFunctions("CQL2");

  it("one statement each, in ASCII (values as hex), committed at the end; schema-qualified on request", () => {
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.every((s) => /^[\x09\x0a\x20-\x7e]*$/.test(s))).toBe(true);
    // SQL statements carry no terminator (the driver refuses one); PL/SQL units end with END;.
    for (const s of statements) expect(s.startsWith("CREATE OR REPLACE") ? s.endsWith("END;") : !s.endsWith(";")).toBe(true);
    for (const name of ["cql2_casei", "cql2_accenti", "cql2_day", "cql2_instant", "cql2_arithmetic", "cql2_geometry", "cql2_relate"]) {
      expect(statements.some((s) => s.startsWith(`CREATE OR REPLACE FUNCTION "CQL2".${name}(`))).toBe(true);
    }
    expect(oracleFunctions().some((s) => s.startsWith("CREATE OR REPLACE FUNCTION cql2_casei("))).toBe(true);
  });

  it("the package's tables: case folding, accent marks, and canonical composition", () => {
    const rows = (table: string) => statements.find((s) => s.startsWith(`INSERT INTO "CQL2".${table} `))!.split("\n").length - 2;
    expect(rows("cql2_casefold")).toBe(1530);
    expect(rows("cql2_accent_marks")).toBe(1983);
    expect(rows("cql2_compose")).toBe(941);
    expect(rows("cql2_combining")).toBe(922);
    // ß folds to ss: C39F → 7373.
    expect(statements.find((s) => s.includes("cql2_casefold (from_char"))).toBeDefined();
    expect(statements.some((s) => s.includes("('C39F', '7373')"))).toBe(true);
  });
});
