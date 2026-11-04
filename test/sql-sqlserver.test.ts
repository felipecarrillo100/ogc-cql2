/**
 * `toSql`, dialect `sqlserver`: the SQL text and parameters per operator and column type, `sqlserverValue` and
 * `sqlserverFunctions`. Whether that SQL selects what `evaluate` selects is checked against a real SQL Server by
 * demo-server's tests (they skip without one).
 */
import { describe, expect, it } from "vitest";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { sqlConformance, sqlserverFunctions, sqlserverValue, toSql, type SqlColumn } from "ogc-cql2/sql";

const COLUMNS: Record<string, SqlColumn> = {
  name: { type: "string", sqlType: "nvarchar" },
  code: { type: "string", sqlType: "varchar" },
  n: { type: "integer", sqlType: "int" },
  amount: { type: "number", sqlType: "decimal" },
  ratio: { type: "number", sqlType: "float" },
  active: { type: "boolean", sqlType: "bit" },
  day: { type: "string", format: "date", sqlType: "date" },
  at: { type: "string", format: "date-time", sqlType: "datetimeoffset" },
  local_at: { type: "string", sqlType: "datetime2" },
  sday: { type: "string", format: "date", sqlType: "varchar" }, // days held as text
  geometry: { format: "geometry-any", sqlType: "geometry" },
};
const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const sql = (filter: unknown, functionSchema?: string) =>
  toSql(filter as Cql2Filter, { dialect: "sqlserver", columns: COLUMNS, ...(functionSchema ? { functionSchema } : {}) });
const bytes = (x: string) => `CAST(CONVERT(varchar(max), ${x} COLLATE Latin1_General_100_BIN2_UTF8) AS varbinary(max))`;
const MS = (x: string) => `DATEDIFF_BIG(millisecond, CAST('1970-01-01T00:00:00Z' AS datetimeoffset), ${x})`;

describe("the sqlserver dialect", () => {
  it("named @pN placeholders; numbers as float, literals as text", () => {
    expect(sql({ op: "and", args: [{ op: ">", args: [p("n"), 5] }, { op: "=", args: [p("active"), true] }] })).toEqual({
      where: `(CAST("n" AS float) > CAST(@p1 AS float)) AND ("active" = @p2)`,
      params: ["5e+0", true],
    });
    expect(sql({ op: "between", args: [p("ratio"), 1e308, 2.5] })).toEqual({
      where: `"ratio" BETWEEN CAST(@p1 AS float) AND CAST(@p2 AS float)`,
      params: ["1e+308", "2.5e+0"],
    });
    // SQL Server reads a subnormal number's text as 0: it is bound times 2^54 and scaled back (both exact).
    expect(sql({ op: "=", args: [p("ratio"), 1e-320] })).toEqual({
      where: `"ratio" = CAST(@p1 AS float) * POWER(CAST(2 AS float), -54)`,
      params: [(1e-320 * 2 ** 54).toExponential()],
    });
  });

  it("text as its UTF-8 bytes on both sides: code point order, and no blank padding", () => {
    expect(sql({ op: "<", args: [p("name"), "café"] })).toEqual({ where: `${bytes(`"name"`)} < ${bytes("@p1")}`, params: ["café"] });
    expect(sql({ op: "in", args: [p("code"), ["a", "b"]] }).where).toBe(`${bytes(`"code"`)} IN (${bytes("@p1")}, ${bytes("@p2")})`);
    expect(sql({ op: "<", args: [p("name"), p("code")] }).where).toBe(`${bytes(`"name"`)} < ${bytes(`"code"`)}`);
    // '' is a value in SQL Server: compared as it is.
    expect(sql({ op: "=", args: [p("name"), ""] })).toEqual({ where: `${bytes(`"name"`)} = ${bytes("@p1")}`, params: [""] });
  });

  it("LIKE: SQL Server's, `[` escaped, without `_`; cql2_like (code points) with an unescaped `_`", () => {
    // A | after both: SQL Server's LIKE ignores the value's trailing blanks.
    const native = (param: string) => `CONVERT(varchar(max), ("name" + N'|') COLLATE Latin1_General_100_BIN2_UTF8) LIKE CONVERT(varchar(max), (${param} + N'|') COLLATE Latin1_General_100_BIN2_UTF8) ESCAPE '\\'`;
    expect(sql({ op: "like", args: [p("name"), "a[b]%"] })).toEqual({ where: native("@p1"), params: ["a\\[b]%"] });
    expect(sql({ op: "like", args: [p("name"), "100\\%"] }).params).toEqual(["100\\%"]);
    expect(sql({ op: "like", args: [p("name"), "a\\_b"] })).toEqual({ where: native("@p1"), params: ["a\\_b"] }); // an escaped _: native
    expect(sql({ op: "like", args: [p("name"), "\\a\\[x"] }).params).toEqual(["a\\[x"]);
    expect(sql({ op: "like", args: [p("name"), "end\\"] }).params).toEqual(["end\\\\"]);
    expect(sql({ op: "like", args: [p("name"), "a_b"] })).toEqual({ where: `"dbo".cql2_like("name", @p1) = 1`, params: ["a_b"] });
    expect(sql({ op: "like", args: [p("name"), "\\\\_"] }).where).toBe(`"dbo".cql2_like("name", @p1) = 1`); // \\ then _
    expect(sql({ op: "like", args: [casei(p("name")), casei("A_")] }, "cql2").where).toBe(`"cql2".cql2_like("cql2".cql2_casei("name"), @p1) = 1`);
  });

  it("CASEI and ACCENTI through the cql2_* functions, by two-part name (dbo unless functionSchema)", () => {
    expect(sql({ op: "=", args: [casei(p("name")), casei("STRASSE")] })).toEqual({
      where: `${bytes(`"dbo".cql2_casei("name")`)} = ${bytes("@p1")}`,
      params: ["strasse"],
    });
    expect(sql({ op: "=", args: [casei(p("name")), casei("A")] }, "cql2").where).toContain(`"cql2".cql2_casei("name")`);
  });

  it("days as dates (the index applies), instants as epoch milliseconds in UTC, text as served", () => {
    expect(sql({ op: ">=", args: [p("day"), { date: "2020-07-26" }] })).toEqual({ where: `"day" >= CAST(@p1 AS date)`, params: ["2020-07-26"] });
    expect(sql({ op: "<", args: [p("at"), { timestamp: "2023-01-01T00:00:00.5Z" }] })).toEqual({
      where: `${MS(`"at"`)} < CAST(@p1 AS bigint)`,
      params: ["1672531200500"],
    });
    expect(sql({ op: "=", args: [p("sday"), { date: "2020-07-26" }] }).where).toBe(`"dbo".cql2_day("sday") COLLATE Latin1_General_BIN2 = CAST(@p1 AS varchar(10))`);
    expect(sql({ op: "=", args: [p("code"), { timestamp: "2020-07-26T00:00:00Z" }] }).where).toBe(`"dbo".cql2_instant("code") = CAST(@p1 AS bigint)`);
    // A date against days held as text: both as YYYY-MM-DD, in byte order (a linguistic collation ignores '-').
    expect(sql({ op: "<", args: [p("day"), p("sday")] }).where).toBe(
      `CONVERT(varchar(10), "day", 23) COLLATE Latin1_General_BIN2 < "dbo".cql2_day("sday") COLLATE Latin1_General_BIN2`,
    );
  });

  it("no boolean values in T-SQL: TRUE, FALSE and NULL as conditions; a condition as a value as 1 / 0 / NULL", () => {
    expect(sql(true).where).toBe("1 = 1");
    expect(sql(false).where).toBe("1 = 0");
    expect(sql({ op: "=", args: [p("n"), "5"] }).where).toBe("1 = NULL"); // no value can match: NULL
    expect(sql({ op: "not", args: [{ op: "=", args: [p("local_at"), { date: "2020-01-01" }] }] }).where).toBe("NOT (1 = NULL)");
    // An interval of two columns: CASE WHEN <its ends are in order> THEN <the relation as 1 / 0> END = 1.
    const relation = `${MS(`"at"`)} > CAST(@p1 AS bigint)`;
    expect(sql({ op: "t_after", args: [{ interval: [p("at"), p("at")] }, { timestamp: "2020-01-01T00:00:00Z" }] }).where).toBe(
      `CASE WHEN ${MS(`"at"`)} <= ${MS(`"at"`)} THEN CASE WHEN ${relation} THEN 1 WHEN NOT (${relation}) THEN 0 END END = 1`,
    );
    // Two text columns in a temporal function, as days and as instants: the first of the answers that isn't NULL.
    const { where } = sql({ op: "t_before", args: [p("code"), p("name")] });
    expect(where).toMatch(/^COALESCE\(CASE WHEN .*cql2_day.* THEN 1 WHEN NOT \(.*\) THEN 0 END, CASE WHEN .*cql2_instant.* END\) = 1$/);
  });

  it("arithmetic through cql2_arithmetic (never an error); an expression of literals computed here", () => {
    const op = (o: string, a: unknown, b: unknown) => ({ op: o, args: [a, b] });
    expect(sql({ op: ">", args: [op("*", p("amount"), 0.001), p("n")] })).toEqual({
      where: `"dbo".cql2_arithmetic('*', CAST("amount" AS float), CAST(@p1 AS float)) > CAST("n" AS float)`,
      params: ["1e-3"],
    });
    expect(sql({ op: ">", args: [p("n"), op("+", 1038290, op("^", 2, 3))] })).toEqual({ where: `CAST("n" AS float) > CAST(@p1 AS float)`, params: ["1.038298e+6"] });
  });

});

describe("Basic Spatial Functions in the sqlserver dialect", () => {
  const G: Record<string, SqlColumn> = {
    geometry: { format: "geometry-any", sqlType: "geometry", column: "geom" },
    mercator: { format: "geometry-any", sqlType: "geometry", srid: 3857 },
    other: { format: "geometry-any", sqlType: "geometry" },
    name: { type: "string", sqlType: "nvarchar" },
  };
  const s = (filter: unknown) => toSql(filter as Cql2Filter, { dialect: "sqlserver", columns: G });
  const lit = (n: number, srid = 4326) => `geometry::STGeomFromWKB(CONVERT(varbinary(max), @p${n}, 2), ${srid})`;
  const pt = (x: number, y: number, z?: number) => ({ type: "Point", coordinates: z === undefined ? [x, y] : [x, y, z] });
  // ISO WKB, little-endian: 01, the type, then doubles.
  const POINT_1_2 = "0101000000000000000000F03F0000000000000040";

  it("S_INTERSECTS at distance 0, the literal as exact WKB in the column's SRID; an empty geometry intersects nothing", () => {
    expect(s({ op: "s_intersects", args: [p("geometry"), pt(1, 2)] })).toEqual({
      where: `("geom".STIsEmpty() = 0 AND "geom".STDistance(${lit(1)}) <= 0)`,
      params: [POINT_1_2],
    });
    expect(s({ op: "s_intersects", args: [p("mercator"), pt(1, 2)] }).where).toContain(lit(1, 3857));
    expect(s({ op: "s_intersects", args: [p("geometry"), pt(1, 2, 3)] }).params).toEqual([POINT_1_2]); // heights dropped
    expect(s({ op: "not", args: [{ op: "s_intersects", args: [p("geometry"), pt(1, 2)] }] }).where).toBe(
      `NOT (("geom".STIsEmpty() = 0 AND "geom".STDistance(${lit(1)}) <= 0))`,
    );
    expect(s({ op: "s_intersects", args: [p("name"), pt(1, 2)] }).where).toBe("1 = NULL"); // no geometry: NULL
  });

  it("a box as a polygon, across the antimeridian two; a collection kept", () => {
    const wkb = (literal: unknown) => s({ op: "s_intersects", args: [p("geometry"), literal] }).params[0] as string;
    expect(wkb({ bbox: [0, 1, 2, 3] }).slice(0, 18)).toBe("010300000001000000"); // a polygon of one ring
    expect(wkb({ bbox: [170, 0, -170, 1] }).slice(0, 20)).toBe("01060000000200000001"); // a multipolygon of two
    expect(wkb({ type: "GeometryCollection", geometries: [pt(1, 2), pt(3, 4)] }).slice(0, 18)).toBe("010700000002000000");
  });

  it("two geometry columns; a literal first; two literals decided here", () => {
    expect(s({ op: "s_intersects", args: [p("geometry"), p("other")] }).where).toBe(
      `("geom".STIsEmpty() = 0 AND "other".STIsEmpty() = 0 AND "geom".STDistance("other") <= 0)`,
    );
    expect(s({ op: "s_intersects", args: [pt(1, 2), p("geometry")] })).toEqual(s({ op: "s_intersects", args: [p("geometry"), pt(1, 2)] }));
    expect(s({ op: "s_intersects", args: [pt(1, 2), { bbox: [0, 0, 1, 2] }] }).where).toBe("1 = 1");
  });

  it("Spatial Functions refused, S_DISJOINT with them (it belongs to that class): write NOT S_INTERSECTS", () => {
    expect(sqlConformance({ dialect: "sqlserver" })).toEqual(Object.values(CONFORMANCE).filter((c) => c !== CONFORMANCE.spatial));
    for (const op of ["s_disjoint", "s_within", "s_touches", "s_equals"]) {
      expect(() => s({ op, args: [p("geometry"), pt(1, 2)] })).toThrowError(expect.objectContaining({ code: "unsupported" }));
    }
  });
});

describe("sqlserverValue: what the application selects, so it serves what the SQL compares", () => {
  const iso = (x: string) => `CONVERT(varchar(19), ${x}, 126) + '.' + RIGHT('00' + CAST(DATEPART(millisecond, ${x}) AS varchar(3)), 3)`;
  it.for([
    ["name", `"name"`],
    ["n", `CAST("n" AS float)`],
    ["ratio", `"ratio"`],
    ["active", `"active"`],
    ["day", `CONVERT(varchar(10), "day", 23)`],
    ["local_at", iso(`"local_at"`)],
    ["at", `${iso(`CAST(SWITCHOFFSET("at", '+00:00') AS datetime2(7))`)} + 'Z'`],
    ["geometry", `"geometry".STAsBinary()`],
  ])("%s", ([name, expected]) => {
    expect(sqlserverValue(name!, COLUMNS[name!]!)).toBe(expected);
  });

  it("a type the dialect can't compare: undefined", () => {
    expect(sqlserverValue("x", { sqlType: "ntext" })).toBeUndefined();
    expect(sqlserverValue("x", { sqlType: "varbinary" })).toBeUndefined();
  });
});

describe("sqlserverFunctions", () => {
  const batches = sqlserverFunctions("cql2");

  it("one batch each, in ASCII; the functions schema-qualified", () => {
    expect(batches.every((s) => /^[\x09\x0a\x20-\x7e]*$/.test(s))).toBe(true);
    for (const name of ["cql2_casei", "cql2_accenti", "cql2_like", "cql2_day", "cql2_instant", "cql2_arithmetic"]) {
      expect(batches.some((s) => s.startsWith(`CREATE OR ALTER FUNCTION "cql2".${name}(`))).toBe(true);
    }
    expect(sqlserverFunctions().some((s) => s.startsWith(`CREATE OR ALTER FUNCTION "dbo".cql2_casei(`))).toBe(true);
  });

  it("the package's tables, as code points: folding, marks, decompositions, classes, compositions", () => {
    const rows = (table: string) => batches.find((s) => s.startsWith(`INSERT INTO "cql2".${table} `))!.split("\n").length - 1;
    expect(rows("cql2_casefold")).toBe(1650); // 1,530 code points, a row per code point of their folds
    expect(rows("cql2_accent_marks")).toBe(1983);
    expect(rows("cql2_decomposition")).toBe(3406); // 2,061 decompositions
    expect(rows("cql2_combining")).toBe(922);
    expect(rows("cql2_compose")).toBe(941);
  });
});
