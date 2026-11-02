/**
 * `toSql`, dialect `postgres`: the SQL text and parameters per operator and column type, and `postgresFunctions`.
 * Whether that SQL selects what `evaluate` selects is checked against a real PostgreSQL by demo-server's tests.
 */
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { postgresFunctions, postgresValue, toSql, type SqlColumn } from "ogc-cql2/sql";

const COLUMNS: Record<string, SqlColumn> = {
  name: { type: "string", sqlType: "text" },
  code: { type: "string", sqlType: "character varying(10)" },
  n: { type: "integer", sqlType: "integer" },
  amount: { type: "number", sqlType: "numeric(12,2)" },
  active: { type: "boolean", sqlType: "boolean" },
  day: { type: "string", format: "date", sqlType: "date" },
  at: { type: "string", format: "date-time", sqlType: "timestamp(3) with time zone" },
  local_at: { type: "string", sqlType: "timestamp without time zone" },
  plain: { type: "string" }, // no sqlType: read from the queryable
  label: { type: "string", sqlType: "text", column: 'odd "name"' },
};
const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const sql = (filter: unknown, functionSchema?: string) =>
  toSql(filter as Cql2Filter, { dialect: "postgres", columns: COLUMNS, ...(functionSchema ? { functionSchema } : {}) });

describe("the postgres dialect", () => {
  it("$n placeholders, with the casts each column needs", () => {
    expect(sql({ op: "and", args: [{ op: ">", args: [p("n"), 5] }, { op: "=", args: [p("active"), true] }] })).toEqual({
      where: `("n"::double precision > $1::double precision) AND ("active" = $2::boolean)`,
      params: [5, true],
    });
    expect(sql({ op: "between", args: [p("amount"), 1, 2.5] }).where).toBe(
      `"amount"::double precision BETWEEN $1::double precision AND $2::double precision`,
    );
  });

  it("text in code point order (COLLATE \"C\"), NFC on both sides", () => {
    expect(sql({ op: "<", args: [p("name"), "café"] })).toEqual({
      where: `normalize("name"::text, NFC) COLLATE "C" < $1`,
      params: ["café"],
    });
    expect(sql({ op: "=", args: [p("code"), "x"] }).where).toBe(`normalize("code"::text, NFC) COLLATE "C" = $1`);
    expect(sql({ op: "=", args: [p("label"), "x"] }).where).toBe(`normalize("odd ""name"""::text, NFC) COLLATE "C" = $1`);
  });

  it("CASEI through cql2_casei, schema-qualified on request", () => {
    expect(sql({ op: "=", args: [casei(p("name")), casei("STRASSE")] })).toEqual({
      where: `cql2_casei(normalize("name"::text, NFC)) COLLATE "C" = $1`,
      params: ["strasse"],
    });
    expect(sql({ op: "=", args: [casei(p("name")), casei("A")] }, "cql2demo").where).toBe(
      `"cql2demo".cql2_casei(normalize("name"::text, NFC)) COLLATE "C" = $1`,
    );
  });

  it("dates and instants: native on date / timestamptz columns (infinity as NULL), as the served text otherwise", () => {
    // An infinite date is NULL: FALSE selects the same rows outside a NOT, TRUE inside one; the column keeps its index.
    expect(sql({ op: ">=", args: [p("day"), { date: "2020-07-26" }] })).toEqual({
      where: `("day" >= $1::date AND isfinite("day"))`,
      params: ["2020-07-26"],
    });
    expect(sql({ op: "not", args: [{ op: ">=", args: [p("day"), { date: "2020-07-26" }] }] }).where).toBe(
      `NOT (("day" >= $1::date OR NOT isfinite("day")))`,
    );
    expect(sql({ op: "<", args: [p("at"), { timestamp: "2023-01-01T00:00:00.5Z" }] })).toEqual({
      where: `(CASE WHEN isfinite("at") THEN date_trunc('milliseconds', "at") END) < $1::timestamptz`,
      params: ["2023-01-01T00:00:00.500Z"],
    });
    expect(sql({ op: "=", args: [p("name"), { date: "2020-07-26" }] }).where).toBe(`cql2_day("name"::text) COLLATE "C" = $1`);
    expect(sql({ op: "=", args: [p("name"), { timestamp: "2020-07-26T00:00:00Z" }] }).where).toBe(
      `cql2_instant("name"::text) = $1::timestamptz`,
    );
    expect(sql({ op: "=", args: [p("at"), "2023-01-01T00:00:00.000Z"] }).where).toBe(
      `COALESCE(to_char("at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), "at"::text) COLLATE "C" = $1`,
    );
    expect(sql({ op: "=", args: [p("plain"), { date: "2020-07-26" }] }).where).toBe(`cql2_day("plain"::text) COLLATE "C" = $1`);
  });

  it("Temporal Functions: the ends compared in their views; a CASE gives NULL where an interval reads the table", () => {
    const iv = (a: unknown, b: unknown) => ({ interval: [a, b] });
    // One property against literals: every comparison reads it, so NULL comes through; the index still applies.
    expect(sql({ op: "t_intersects", args: [p("day"), iv("2020-01-01", "2020-12-31")] })).toEqual({
      where: `(("day" <= $1::date AND isfinite("day"))) AND (("day" >= $2::date AND isfinite("day")))`,
      params: ["2020-12-31", "2020-01-01"],
    });
    expect(sql({ op: "t_after", args: [p("day"), iv("..", "2020-12-31")] }).where).toBe(`("day" > $1::date AND isfinite("day"))`);
    // An interval of two columns: NULL unless both ends are values and it begins before it ends.
    expect(sql({ op: "t_meets", args: [iv(p("day"), p("day")), iv("2020-01-01", "2020-02-01")] })).toEqual({
      where: `CASE WHEN (isfinite("day")) AND (isfinite("day")) AND (to_char("day", 'YYYY-MM-DD') COLLATE "C" <= to_char("day", 'YYYY-MM-DD') COLLATE "C") THEN "day" = $1::date END`,
      params: ["2020-01-01"],
    });
    expect(sql({ op: "t_disjoint", args: [p("name"), p("name")] }).where).toBe(
      `COALESCE(CASE WHEN (cql2_day("name"::text) COLLATE "C" IS NOT NULL) AND (cql2_day("name"::text) COLLATE "C" IS NOT NULL) THEN (cql2_day("name"::text) COLLATE "C" < cql2_day("name"::text) COLLATE "C") OR (cql2_day("name"::text) COLLATE "C" > cql2_day("name"::text) COLLATE "C") END, CASE WHEN (cql2_instant("name"::text) IS NOT NULL) AND (cql2_instant("name"::text) IS NOT NULL) THEN (cql2_instant("name"::text) < cql2_instant("name"::text)) OR (cql2_instant("name"::text) > cql2_instant("name"::text)) END)`,
    );
    // Literals only: decided here; an interval beginning after it ends is NULL.
    expect(sql({ op: "t_before", args: [iv("2020-01-01", "2020-02-01"), iv("2020-03-01", "..")] }).where).toBe("TRUE");
    expect(sql({ op: "not", args: [{ op: "t_before", args: [iv("2020-02-01", "2020-01-01"), iv("2020-03-01", "..")] }] }).where).toBe("NOT (NULL::boolean)");
    // A date column against an instant: no value can match.
    expect(sql({ op: "t_after", args: [p("day"), { timestamp: "2020-01-01T00:00:00Z" }] }).where).toBe("NULL::boolean");
  });

  it("a literal no value of the column can match is NULL, typed", () => {
    expect(sql({ op: "=", args: [p("n"), "5"] })).toEqual({ where: "NULL::boolean", params: [] });
    expect(sql({ op: "=", args: [p("name"), 5] }).where).toBe("NULL::boolean");
    expect(sql({ op: "=", args: [p("local_at"), { timestamp: "2023-01-01T00:00:00Z" }] }).where).toBe("NULL::boolean");
    expect(sql({ op: "=", args: [p("at"), { date: "2023-01-01" }] }).where).toBe("NULL::boolean");
    expect(sql({ op: "not", args: [{ op: "=", args: [p("active"), 1] }] }).where).toBe("NOT (NULL::boolean)");
  });

  it("LIKE natively, case-sensitive; a lone trailing backslash is a literal one", () => {
    expect(sql({ op: "like", args: [p("name"), "Riv%"] })).toEqual({ where: `normalize("name"::text, NFC) COLLATE "C" LIKE $1`, params: ["Riv%"] });
    expect(sql({ op: "like", args: [p("name"), "end\\"] }).params).toEqual(["end\\\\"]);
    expect(sql({ op: "like", args: [p("name"), "end\\\\"] }).params).toEqual(["end\\\\"]);
    expect(sql({ op: "like", args: [casei(p("name")), casei("RIV%")] }).where).toBe(`cql2_casei(normalize("name"::text, NFC)) COLLATE "C" LIKE $1`);
  });

  it("IN, isNull, true and false", () => {
    expect(sql({ op: "in", args: [p("n"), [1, 2]] })).toEqual({
      where: `"n"::double precision IN ($1::double precision, $2::double precision)`,
      params: [1, 2],
    });
    expect(sql({ op: "isNull", args: [p("day")] }).where).toBe(`"day" IS NULL`);
    expect(sql(true).where).toBe("TRUE");
    expect(sql(false).where).toBe("FALSE");
  });
});

describe("Property-Property Comparisons in the postgres dialect", () => {
  const COLS: Record<string, SqlColumn> = { ...COLUMNS, other: { type: "string", sqlType: "text" }, sday: { type: "string", format: "date", sqlType: "text" } };
  const pp = (filter: unknown) => toSql(filter as Cql2Filter, { dialect: "postgres", columns: COLS });

  it("two columns: their views, compared directly", () => {
    expect(pp({ op: "<", args: [p("name"), p("other")] })).toEqual({
      where: `normalize("name"::text, NFC) COLLATE "C" < normalize("other"::text, NFC) COLLATE "C"`,
      params: [],
    });
    expect(pp({ op: "=", args: [casei(p("name")), p("other")] }).where).toBe(
      `cql2_casei(normalize("name"::text, NFC)) COLLATE "C" = normalize("other"::text, NFC) COLLATE "C"`,
    );
  });

  it("a date column against dates held as text: both as YYYY-MM-DD text", () => {
    expect(pp({ op: "<", args: [p("day"), p("sday")] }).where).toBe(
      `to_char("day", 'YYYY-MM-DD') COLLATE "C" < cql2_day("sday"::text) COLLATE "C"`,
    );
  });

  it("a literal on the left is the property on the left, the operator mirrored", () => {
    expect(pp({ op: "<", args: [5, p("n")] })).toEqual(pp({ op: ">", args: [p("n"), 5] }));
  });

  it("two literals: TRUE or FALSE; BETWEEN and IN with properties: ANDs and ORs of comparisons", () => {
    expect(pp({ op: "<", args: ["a", "b"] }).where).toBe("TRUE");
    expect(pp({ op: "between", args: [p("n"), p("amount"), 10] }).where).toBe(
      `("n"::double precision >= "amount"::double precision) AND ("n"::double precision <= $1::double precision)`,
    );
    expect(pp({ op: "in", args: [p("n"), [p("amount"), 3]] }).where).toBe(
      `(("n"::double precision = "amount"::double precision) OR ("n"::double precision = $1::double precision))`,
    );
  });

  it("columns whose types can't be compared: refused", () => {
    expect(() => pp({ op: "=", args: [p("name"), p("n")] })).toThrowError(expect.objectContaining({ code: "invalid-filter", path: "/args/1" }));
  });
});

describe("Arithmetic Expressions in the postgres dialect", () => {
  const op = (o: string, a: unknown, b: unknown) => ({ op: o, args: [a, b] });

  it("through cql2_arithmetic, doubles, schema-qualified on request; an expression of literals computed here", () => {
    expect(sql({ op: ">", args: [p("n"), op("*", p("amount"), 0.001)] })).toEqual({
      where: `"n"::double precision > cql2_arithmetic('*', "amount"::double precision, $1::double precision)`,
      params: [0.001],
    });
    expect(sql({ op: ">", args: [p("n"), op("div", p("n"), 2)] }, "cql2demo").where).toBe(
      `"n"::double precision > "cql2demo".cql2_arithmetic('div', "n"::double precision, $1::double precision)`,
    );
    expect(sql({ op: ">", args: [p("n"), op("+", 1038290, op("^", 2, 3))] })).toEqual({ where: `"n"::double precision > $1::double precision`, params: [1038298] });
    expect(sql({ op: ">", args: [p("n"), op("/", 1, 0)] }).where).toBe("NULL::boolean"); // a NULL, computed here
  });

  it("a column that holds no number makes the expression NULL", () => {
    expect(sql({ op: ">", args: [p("n"), op("+", p("name"), 1)] }).where).toBe("NULL::boolean");
  });

  it("postgresFunctions creates cql2_arithmetic, which turns PostgreSQL's range and domain errors into evaluate's results", () => {
    const text = postgresFunctions("cql2demo");
    expect(text).toContain(`CREATE OR REPLACE FUNCTION "cql2demo".cql2_arithmetic(op text, a double precision, b double precision)`);
    expect(text).toContain("WHEN division_by_zero OR invalid_argument_for_power_function THEN");
    expect(text).toContain("WHEN numeric_value_out_of_range THEN");
  });
});

describe("postgresValue: what the application selects, so it serves what the SQL compares", () => {
  it.each([
    ["name", `"name"`],
    ["n", `"n"::double precision`],
    ["active", `"active"`],
    // Infinity as `infinity` / `-infinity` (to_char gives NULL): no date, but not NULL either.
    ["day", `COALESCE(to_char("day", 'YYYY-MM-DD'), "day"::text)`],
    ["at", `COALESCE(to_char("at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), "at"::text)`],
    ["local_at", `COALESCE(to_char("local_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), "local_at"::text)`],
  ])("%s", (name, expected) => {
    expect(postgresValue(name, COLUMNS[name]!)).toBe(expected);
  });

  it("nothing for a type the dialect can't compare", () => {
    expect(postgresValue("j", { sqlType: "jsonb" })).toBeUndefined();
    expect(postgresValue("u", { sqlType: "uuid" })).toBeUndefined();
    expect(postgresValue("a", { sqlType: "integer[]" })).toBeUndefined();
  });
});

describe("postgresFunctions", () => {
  const text = postgresFunctions("cql2demo");

  it("creates the case-folding table and the three functions, in the schema", () => {
    expect(text).toContain(`CREATE TABLE IF NOT EXISTS "cql2demo".cql2_casefold`);
    for (const name of ["cql2_casei", "cql2_day", "cql2_instant"]) {
      expect(text).toContain(`CREATE OR REPLACE FUNCTION "cql2demo".${name}(t text)`);
    }
  });

  it("holds all 1,530 case-folding mappings, quotes doubled", () => {
    const rows = text.split("\n").filter((line) => /^\('.*', '.*'\)[,;]$/.test(line));
    expect(rows).toHaveLength(1530);
    expect(text).toContain("('ß', 'ss')");
    expect(text).toContain("('Σ', 'σ')");
  });
});

describe("S_INTERSECTS in PostGIS", () => {
  const geo: Record<string, SqlColumn> = {
    geometry: { sqlType: "geometry(MultiPolygon, 4326)", column: "geom" },
    mercator: { sqlType: "geometry(Geometry, 3857)" },
    explicit: { sqlType: "geometry", srid: 2154 },
    geog: { sqlType: "geography" },
    queryable: { format: "geometry-any" },
    name: { type: "string", sqlType: "text" },
  };
  const s = (property: string, literal: unknown) =>
    toSql({ op: "s_intersects", args: [p(property), literal] } as unknown as Cql2Filter, { dialect: "postgres", columns: geo });

  it("the box test uses the index, GEOS's DE-9IM decides exactly (on arm64, ST_Intersects and, from PostGIS 3.7, ST_Disjoint miss points on edges)", () => {
    expect(s("geometry", { type: "Point", coordinates: [7.02, 49.92] })).toEqual({
      where: `("geom" && ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AND NOT ST_Relate("geom", ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 'FF*FF****'))`,
      params: ['{"type":"Point","coordinates":[7.02,49.92]}'],
    });
  });

  it("a GeometryCollection literal is the OR of its members (GEOS 3.11 can't relate a collection)", () => {
    const point = { type: "Point", coordinates: [1, 2] };
    const line = { type: "LineString", coordinates: [[0, 0], [1, 1]] };
    const square = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const L = (n: number) => `ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)`;
    const leaf = (n: number) => `("geom" && ${L(n)} AND NOT ST_Relate("geom", ${L(n)}, 'FF*FF****'))`;
    expect(s("geometry", { type: "GeometryCollection", geometries: [point, line, square] })).toEqual({
      where: `(${leaf(1)} OR ${leaf(2)} OR ${leaf(3)})`,
      params: [JSON.stringify(point), JSON.stringify(line), JSON.stringify(square)],
    });
  });

  it("a box as an envelope; across the antimeridian two; heights left out", () => {
    const env = (w: string, e: string) => `ST_MakeEnvelope(${w}::double precision, $1::double precision, ${e}::double precision, $2::double precision, 4326)`;
    expect(s("geometry", { bbox: [0, 40, 10, 50] })).toEqual({
      where: `("geom" && ${env("$3", "$4")} AND NOT ST_Relate("geom", ${env("$3", "$4")}, 'FF*FF****'))`,
      params: [40, 50, 0, 10],
    });
    expect(s("geometry", { bbox: [170, -10, -170, 10] })).toEqual({
      where: `(("geom" && ${env("$3", "180")} AND NOT ST_Relate("geom", ${env("$3", "180")}, 'FF*FF****')) OR ("geom" && ${env("-180", "$4")} AND NOT ST_Relate("geom", ${env("-180", "$4")}, 'FF*FF****')))`,
      params: [-10, 10, 170, -170],
    });
    expect(s("geometry", { bbox: [0, 40, -100, 10, 50, 100] }).params).toEqual([40, 50, 0, 10]);
  });

  it("another SRID: the column transformed to 4326 (planar in CRS84), from the type or from srid; geography as geometry", () => {
    expect(s("mercator", { bbox: [0, 0, 1, 1] }).where).toContain(`ST_Transform("mercator", 4326) && `);
    expect(s("explicit", { bbox: [0, 0, 1, 1] }).where).toContain(`ST_Transform("explicit", 4326) && `);
    expect(s("geog", { bbox: [0, 0, 1, 1] }).where).toContain(`"geog"::geometry && `);
    expect(s("queryable", { bbox: [0, 0, 1, 1] }).where).toContain(`("queryable" && `);
  });

  it("a column that holds no geometry: nothing matches", () => {
    expect(s("name", { bbox: [0, 0, 1, 1] })).toEqual({ where: "NULL::boolean", params: [] });
  });

  it("the other relations: each exact, behind the index operator that finds its candidates", () => {
    const L = `ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)`;
    const square = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const r = (op: string, literal: unknown = square) =>
      toSql({ op, args: [p("geometry"), literal] } as unknown as Cql2Filter, { dialect: "postgres", columns: geo }).where;
    expect(r("s_equals")).toBe(`ST_Equals("geom", ${L})`);
    expect(r("s_within")).toBe(`("geom" @ ${L} AND ST_Relate("geom", ${L}, 'T*F**F***'))`);
    expect(r("s_contains")).toBe(`("geom" ~ ${L} AND ST_Relate("geom", ${L}, 'T*****FF*'))`);
    expect(r("s_touches")).toBe(`("geom" && ${L} AND ST_Touches("geom", ${L}))`);
    expect(r("s_overlaps")).toBe(`("geom" && ${L} AND ST_Overlaps("geom", ${L}))`);
    expect(r("s_crosses")).toBe(`("geom" && ${L} AND ST_Crosses("geom", ${L}))`);
    expect(r("s_disjoint")).toBe(`NOT (("geom" && ${L} AND NOT ST_Relate("geom", ${L}, 'FF*FF****')))`);
    // A box across the antimeridian: one literal, its halves collected; a collection kept whole.
    expect(r("s_within", { bbox: [170, -10, -170, 10] })).toMatch(/^\("geom" @ ST_Collect\(ST_MakeEnvelope\(.+\), ST_MakeEnvelope\(.+\)\) AND ST_Relate\(/);
    const collection = { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [1, 2] }, square] };
    expect(r("s_touches", collection)).toBe(`("geom" && ${L} AND ST_Touches("geom", ${L}))`);
    // Another SRID and geography: the column as for S_INTERSECTS.
    expect(toSql({ op: "s_within", args: [p("mercator"), square] } as unknown as Cql2Filter, { dialect: "postgres", columns: geo }).where).toContain(`ST_Transform("mercator", 4326) @ `);
    expect(toSql({ op: "s_within", args: [p("name"), square] } as unknown as Cql2Filter, { dialect: "postgres", columns: geo }).where).toBe("NULL::boolean");
  });
});
