/**
 * `toSql`, dialect `sqlite`. The differential test runs every generated filter on a real SQLite table (`node:sqlite`)
 * and with `evaluate` on the same rows: both must select exactly the same rows. The table is typed the GeoPackage way
 * and holds the values most likely to break that: NULLs, values of another type than declared (which GeoPackage
 * readers must allow for), booleans as 0 / 1, date-times with and without seconds or offsets, Unicode in NFC and NFD,
 * code points above U+FFFF, and LIKE's special characters.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { sqliteFunctions, toSql, type SqlColumn } from "ogc-cql2/sql";
import { validate } from "ogc-cql2/validate";

// --- The table -------------------------------------------------------------------------------------------------------

const COLUMNS: Record<string, SqlColumn> = {
  b: { type: "boolean" },
  i: { type: "integer" },
  d: { type: "number" },
  s: { type: "string" },
  day: { type: "string", format: "date" },
  ts: { type: "string", format: "date-time" },
  x: {}, // a column whose values' types aren't known in advance
  label: { type: "string", column: 'odd "name"' }, // a property mapped to a column with an awkward name
};

const ROWS: Record<string, unknown>[] = [
  { b: 1, i: 5, d: 2.5, s: "Straße", day: "2020-07-26", ts: "2023-01-01T00:00:00Z", x: 5, label: "Riv" },
  { b: 0, i: 10, d: -1, s: "STRASSE", day: "2021-01-01", ts: "2023-01-01T00:00Z", x: "5", label: "river" },
  { b: null, i: null, d: null, s: null, day: null, ts: null, x: null, label: null },
  { b: 2, i: "5", d: 5, s: "café", day: "2020-07-26T00:00:00Z", ts: "2022-12-31T23:59:59.999+01:00", x: 1, label: "River" },
  { b: "yes", i: 3.5, d: 0, s: "café", day: "2020-7-26", ts: "2023-01-01T10:00:00", x: 0, label: "100%" },
  { b: 1, i: 0, d: 10, s: "", day: "1999-12-31", ts: "2023-01-01T00:00:00.000Z", x: 2.5, label: "a_b" },
  { b: 0, i: -1, d: 1, s: "😀", day: 20200726, ts: "2022-12-31T23:00:00Z", x: "café", label: "back\\slash" },
  { b: 1, i: 1, d: 0.5, s: "Ελλάδα", day: "2020-07-27", ts: 1672531200000, x: "2020-07-26", label: "" },
  { b: 0, i: 2, d: 3, s: "ΕΛΛΆΔΑ", day: "2020-07-26", ts: "2024-02-29T12:30:00+05:30", x: "2023-01-01T00:00:00Z", label: "Straße" },
  { b: 1, i: 7, d: 7, s: "İstanbul", day: "2020-07-25", ts: "not a date", x: "Riv", label: "ﬁle" },
  { b: 0, i: 8, d: 8, s: "ﬁle", day: "", ts: "2023-01-01T00:00:00+00:00", x: "river", label: "FILE" },
  { b: 1, i: 9, d: 9, s: "", day: "2021-01-01", ts: "2023-06-15T08:00:00Z", x: "", label: "a b" },
  { b: 0, i: 4, d: 4, s: "100%", day: "2020-01-01", ts: "2023-01-01T00:00:01Z", x: "100%", label: "ab" },
  { b: 1, i: 6, d: 6, s: "a_b", day: "2022-02-02", ts: "2023-01-01T00:00:00Z", x: "a_b", label: "a\nb" },
  // Numbers that aren't finite: SQLite stores ±Infinity, and NaN as NULL.
  { b: 0, i: -Infinity, d: Infinity, s: "inf", day: "2023-01-02", ts: "2023-01-02T00:00:00Z", x: Infinity, label: "inf" },
  { b: 1, i: 11, d: NaN, s: "nan", day: "2023-01-02", ts: "2023-01-02T00:00:00Z", x: -Infinity, label: "nan" },
  // Accents: Portuguese, Spanish, Vietnamese (two marks, decomposed), Polish, Danish, Japanese voicing marks.
  { b: 1, i: 12, d: 12, s: "São Paulo", day: "2023-01-03", ts: "2023-01-03T00:00:00Z", x: "Sa\u0303o Paulo", label: "SÃO PAULO" },
  { b: 0, i: 13, d: 13, s: "año", day: "2023-01-03", ts: "2023-01-03T00:00:00Z", x: "Año", label: "ano" },
  { b: 1, i: 14, d: 14, s: "Vie\u0323\u0302t Nam", day: "2023-01-03", ts: "2023-01-03T00:00:00Z", x: "Việt", label: "VIET NAM" },
  { b: 0, i: 15, d: 15, s: "Łódź", day: "2023-01-03", ts: "2023-01-03T00:00:00Z", x: "Lodz", label: "Øresund" },
  { b: 1, i: 16, d: 16, s: "はじめ", day: "2023-01-03", ts: "2023-01-03T00:00:00Z", x: "はしめ", label: "Mà" },
];

function makeTable(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) {
    db.function(name, { deterministic: true }, fn as never);
  }
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, b BOOLEAN, i INTEGER, d DOUBLE, s TEXT, day DATE, ts DATETIME,
           x, "odd ""name""" TEXT)`);
  const insert = db.prepare(`INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ROWS.forEach((r, i) => insert.run(i + 1, ...(["b", "i", "d", "s", "day", "ts", "x", "label"].map((k) => r[k] ?? null) as never[])));
  return db;
}

/** A row as an application reads it from the table: GeoPackage's BOOLEAN 0 / 1 become false / true. */
function readRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if (row.b === 0) out.b = false;
  if (row.b === 1) out.b = true;
  return out;
}

const db = makeTable();
const stored = (db.prepare("SELECT * FROM t ORDER BY id").all() as Record<string, unknown>[]).map(readRow);
const getProperty = (row: Record<string, unknown>, name: string) => row[COLUMNS[name]!.column ?? name];

function fromSql(filter: Cql2Filter): number[] {
  const { where, params } = toSql(filter, { dialect: "sqlite", columns: COLUMNS });
  return (db.prepare(`SELECT id FROM t WHERE ${where} ORDER BY id`).all(...(params as never[])) as { id: number }[]).map((r) => r.id);
}
const fromEvaluate = (filter: Cql2Filter): number[] =>
  stored.filter(toPredicate(filter, { getProperty })).map((r) => r.id as number);

// --- The generated filters -------------------------------------------------------------------------------------------

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const accenti = (arg: unknown) => ({ op: "accenti", args: [arg] });
const PROPERTIES = Object.keys(COLUMNS);
const LITERALS: unknown[] = [
  "Straße", "São Paulo", "SAO PAULO", "Sao Paulo", "año", "ano", "はじめ", "はしめ", "Łodz", "Lodz", "Ma\u0300", "STRASSE", "café", "café", "", "😀", "", "Riv", "river", "a_b", "Ελλάδα", "100%",
  0, 1, 2.5, 5, 10, -1, true, false,
  { date: "2020-07-26" }, { date: "2021-01-01" },
  { timestamp: "2023-01-01T00:00:00Z" }, { timestamp: "2022-12-31T23:00:00Z" }, { timestamp: "2023-01-01T00:00:00.5Z" },
];
const OPS = ["=", "<>", "<", "<=", ">", ">="];
const PATTERNS = ["S_o%", "%PAULO", "ano", "は%め", "%", "_%", "", "Stra%", "%ss%", "%SS%", "100\\%", "a\\_b", "a_b", "%é", "ri%", "Ri_", "_", "%😀%", "% %"];

function generate(): Cql2Filter[] {
  const leaves: unknown[] = [true, false];
  for (const name of PROPERTIES) {
    leaves.push({ op: "isNull", args: [p(name)] });
    for (const value of LITERALS) for (const op of OPS) leaves.push({ op, args: [p(name), value] });
    for (const value of LITERALS.filter((v) => typeof v === "string")) {
      for (const op of ["=", "<"]) {
        leaves.push({ op, args: [accenti(p(name)), accenti(value)] });
        leaves.push({ op, args: [accenti(p(name)), value] }, { op, args: [p(name), accenti(value)] });
        leaves.push({ op, args: [casei(accenti(p(name))), casei(accenti(value))] });
        leaves.push({ op, args: [accenti(casei(p(name))), accenti(casei(value))] });
        leaves.push({ op, args: [casei(p(name)), casei(value)] });
        leaves.push({ op, args: [casei(p(name)), value] });
        leaves.push({ op, args: [p(name), casei(value)] });
      }
    }
    for (const pattern of PATTERNS) {
      leaves.push({ op: "like", args: [p(name), pattern] });
      leaves.push({ op: "like", args: [casei(p(name)), casei(pattern)] });
      leaves.push({ op: "like", args: [accenti(p(name)), accenti(pattern)] });
      leaves.push({ op: "like", args: [casei(accenti(p(name))), casei(accenti(pattern))] });
      leaves.push({ op: "like", args: [p(name), casei(pattern)] });
    }
    leaves.push({ op: "between", args: [p(name), 0, 5] }, { op: "between", args: [p(name), -1, 2.5] });
    for (const list of [["Straße", "café"], [5, 10], [true], [{ date: "2020-07-26" }, { date: "1999-12-31" }],
      [{ timestamp: "2023-01-01T00:00:00Z" }], [0, 1]]) {
      leaves.push({ op: "in", args: [p(name), list] });
    }
    leaves.push({ op: "in", args: [casei(p(name)), [casei("strasse"), casei("ελλάδα")]] });
    leaves.push({ op: "in", args: [accenti(p(name)), [accenti("Sao Paulo"), accenti("ano")]] });
  }
  const valid = leaves.filter((f) => validate(f).valid) as Cql2Filter[];
  const nots = valid.map((f) => ({ op: "not", args: [f] }) as Cql2Filter);
  const pairs: Cql2Filter[] = [];
  for (let i = 0; i + 1 < valid.length; i += 7) {
    pairs.push({ op: "and", args: [valid[i]!, valid[i + 1]!] }, { op: "or", args: [valid[i]!, valid[i + 1]!] });
    pairs.push({ op: "not", args: [{ op: "or", args: [valid[i]!, { op: "not", args: [valid[i + 1]!] }] }] });
  }
  return [...valid, ...nots, ...pairs];
}

describe("SQLite selects exactly what evaluate selects", () => {
  const filters = generate();

  it(`${filters.length} filters on ${ROWS.length} rows`, () => {
    expect(filters.length).toBeGreaterThan(1500);
    const differences: string[] = [];
    for (const filter of filters) {
      const sql = fromSql(filter);
      const memory = fromEvaluate(filter);
      if (JSON.stringify(sql) !== JSON.stringify(memory)) {
        differences.push(`${JSON.stringify(filter)}\n    sqlite ${JSON.stringify(sql)}  evaluate ${JSON.stringify(memory)}`);
      }
    }
    expect(differences.slice(0, 20).join("\n")).toBe("");
  });

  it("the test is not trivial: filters select different, non-empty sets", () => {
    const results = new Set(generate().map((f) => JSON.stringify(fromEvaluate(f))));
    expect(results.size).toBeGreaterThan(100);
  });
});

describe("the SQL it builds", () => {
  const sql = (filter: unknown) => toSql(filter as Cql2Filter, { dialect: "sqlite", columns: COLUMNS });

  it("values are parameters, keyed as evaluate keys them; names are quoted", () => {
    expect(sql({ op: "=", args: [p("s"), "café"] })).toEqual({ where: `cql2_text("s") = ?`, params: ["café"] });
    expect(sql({ op: "=", args: [casei(p("s")), casei("STRASSE")] })).toEqual({ where: `cql2_casei("s") = ?`, params: ["strasse"] });
    expect(sql({ op: ">", args: [p("i"), 5] }).where).toBe(`(CASE WHEN typeof("i") IN ('integer', 'real') THEN "i" END) > ?`);
    expect(sql({ op: "=", args: [p("b"), true] })).toEqual({
      where: `(CASE WHEN typeof("b") IN ('integer', 'real') AND "b" IN (0, 1) THEN "b" END) = ?`,
      params: [1],
    });
    expect(sql({ op: "<", args: [p("ts"), { timestamp: "2023-01-01T00:00:00Z" }] })).toEqual({ where: `cql2_instant("ts") < ?`, params: [1672531200000] });
    expect(sql({ op: "like", args: [p("label"), "Riv%"] })).toEqual({ where: `cql2_like(cql2_text("odd ""name"""), ?)`, params: ["Riv%"] });
    expect(sql({ op: "isNull", args: [p("x")] }).where).toBe(`"x" IS NULL`);
  });

  it("booleans only exist in BOOLEAN columns: elsewhere the comparison is NULL", () => {
    expect(sql({ op: "=", args: [p("i"), true] })).toEqual({ where: "NULL", params: [] });
    expect(sql({ op: "not", args: [{ op: "=", args: [p("x"), false] }] }).where).toBe("NOT (NULL)");
  });

  it("true, false, and nesting", () => {
    expect(sql(true).where).toBe("1");
    expect(sql(false).where).toBe("0");
    expect(sql({ op: "and", args: [true, { op: "or", args: [false, { op: "isNull", args: [p("s")] }] }] }).where).toBe(
      `(1) AND ((0) OR ("s" IS NULL))`,
    );
  });

  it("refuses a property that isn't a column, and an invalid filter", () => {
    expect(() => sql({ op: "=", args: [p("nope"), 1] })).toThrow(
      expect.objectContaining({ name: "Cql2Error", code: "unknown-property", path: "/args/0", details: { property: "nope" } }),
    );
    expect(() => sql({ op: "=", args: [p("toString"), 1] })).toThrow(expect.objectContaining({ code: "unknown-property" }));
    expect(() => sql({ op: "eq", property: "s", value: 1 })).toThrow(expect.objectContaining({ code: "invalid-filter" }));
  });
});
