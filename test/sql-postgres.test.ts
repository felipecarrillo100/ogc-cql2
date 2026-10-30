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

  it("dates and instants: native on date / timestamptz columns, as the served text otherwise", () => {
    expect(sql({ op: ">=", args: [p("day"), { date: "2020-07-26" }] })).toEqual({ where: `"day" >= $1::date`, params: ["2020-07-26"] });
    expect(sql({ op: "<", args: [p("at"), { timestamp: "2023-01-01T00:00:00.5Z" }] })).toEqual({
      where: `date_trunc('milliseconds', "at") < $1::timestamptz`,
      params: ["2023-01-01T00:00:00.500Z"],
    });
    expect(sql({ op: "=", args: [p("name"), { date: "2020-07-26" }] }).where).toBe(`cql2_day("name"::text) COLLATE "C" = $1`);
    expect(sql({ op: "=", args: [p("name"), { timestamp: "2020-07-26T00:00:00Z" }] }).where).toBe(
      `cql2_instant("name"::text) = $1::timestamptz`,
    );
    expect(sql({ op: "=", args: [p("at"), "2023-01-01T00:00:00.000Z"] }).where).toBe(
      `to_char("at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') COLLATE "C" = $1`,
    );
    expect(sql({ op: "=", args: [p("plain"), { date: "2020-07-26" }] }).where).toBe(`cql2_day("plain"::text) COLLATE "C" = $1`);
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

describe("postgresValue: what the application selects, so it serves what the SQL compares", () => {
  it.each([
    ["name", `"name"`],
    ["n", `"n"::double precision`],
    ["active", `"active"`],
    ["day", `to_char("day", 'YYYY-MM-DD')`],
    ["at", `to_char("at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`],
    ["local_at", `to_char("local_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS')`],
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
