/**
 * Array Functions in `toSql`'s `sqlite` dialect (since 1.6.0): arrays stored as JSON text, as GDAL writes a
 * GeoPackage's list fields. Every generated array filter selects on a real SQLite table (`node:sqlite`) what
 * `evaluate` selects on the rows as the application serves them: a column declared with `items` as JSON.parse reads
 * it (the text as it is when it doesn't parse), any other column as it is. The table holds the values where SQLite's
 * own JSON reading and JSON.parse part: GDAL's pretty-printed JSON, an integer beyond 2^53, a lone surrogate, `\u0000`,
 * `1e400`; and NULL arrays, NULL elements, repeats, empty arrays, `""`, `"a "`, `"A"`, NFC and NFD, `1` / `1.0`, `-0`,
 * dates and instants as text, malformed JSON, JSON that isn't an array, nested and mixed arrays, values that aren't
 * text (a number, a JSONB blob).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { toEvaluator } from "ogc-cql2/evaluate";
import { sqliteFunctions, toSql, type SqlColumn } from "ogc-cql2/sql";
import { generateArrayFilters } from "./corpus.ts";

/** The columns with their elements' queryables (`items`), as an application declares them. `plain` has none. */
const COLUMNS: Record<string, SqlColumn> = {
  mixed: { sqlType: "TEXT", items: {} },
  tags: { sqlType: "TEXT", items: { type: "string" } },
  ratios: { sqlType: "TEXT", items: { type: "number" } },
  counts: { sqlType: "TEXT", items: { type: "integer" } },
  flags: { sqlType: "TEXT", items: { type: "boolean" } },
  days: { sqlType: "TEXT", items: { type: "string", format: "date" } },
  moments: { sqlType: "TEXT", items: { type: "string", format: "date-time" } },
  plain: { sqlType: "TEXT" },
};
const NAMES = Object.keys(COLUMNS);

/** Rows in the order of COLUMNS: JSON text as stored, SQL NULL, or `{ sql }` for a value inserted as an expression. */
type Stored = string | null | { sql: string };
const ROWS: Stored[][] = [
  [String.raw`[ "a", 1, true, "2010-02-10" ]`, `[ "a", "b" ]`, `[ 1.0, 2.5 ]`, `[ 1, 2 ]`, `[ true, false ]`, `[ "2010-02-10" ]`, `[ "2010-02-10T05:30:00.123Z" ]`, `["a"]`],
  [`[1, 1.0, "1"]`, `["b","a","a"]`, `[2.5, 1, 1]`, `[2, 1, 1]`, `[false, true, true]`, `["2010-02-10", "2010-02-10"]`,
    `["2010-02-10T05:30:00.1234Z", "2010-02-10T05:30:00.123+00:00"]`, `[]`],
  [`[]`, `[]`, `[]`, `[]`, `[]`, `[]`, `[]`, `[]`],
  [null, null, null, null, null, null, null, null],
  [`[null]`, `["a", null]`, `[null, 0.1]`, `[null, 1]`, `[null, true]`, `[null, "2010-02-10"]`, `[null]`, `[null]`],
  [`["", "a ", "A", -0, 0]`, `["", "a ", "A"]`, `[1.0, -0.0, 0.1, 0.10000000000000001]`, `[0, -1]`, `[true]`, `["1969-07-16"]`, `["1969-07-16T13:32:00Z"]`, `x`],
  [String.raw`["é", "\ud800"]`, String.raw`["é", "é", "😀", "a\u0000b", "\ud800"]`, `[1e300, -1e300, 1e400]`, `[9007199254740993, 2147483647, 9007199254740991]`, `[false]`,
    `["2010-02-30", "infinity", "1969-07-16"]`, `["2010-02-10T05:30:00Z", "not a date"]`, null],
  [`[1,]`, String.raw`"[\"a\"]"`, `{"a": 1}`, `5`, `true`, `not json`, ``, `["a"]`],
  [{ sql: "5" }, { sql: `jsonb('["a"]')` }, { sql: "1.5" }, { sql: "x'5b315d'" }, { sql: "1" }, { sql: `jsonb('["2010-02-10"]')` }, { sql: "0" }, { sql: "5" }],
  [`[["a"], {"a": 1}, "a"]`, `[["a"], "b"]`, `[[1], 2.5]`, `["1", 1]`, `[1, true]`, `["2010-02-10T00:00:00Z", "2010-02-10"]`, `["2010-02-10", "2012-08-10T05:30:00+00:00"]`, `["b"]`],
  [`["a", true, 1, "2010-02-10T05:30:00.123Z", 8]`, `["a","c"]`, `[1, 8]`, `[1, 8]`, `[true]`, `["2010-02-10"]`, `["2012-08-10T05:30:00Z"]`, `["c"]`],
  [`["😀", ""]`, `["c"]`, `[2.5]`, `[2]`, `[false]`, `["1969-07-16"]`, `["1969-07-16T13:32:00.0005Z"]`, `["a", "b"]`],
];

function makeTable(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, ${NAMES.map((n) => `"${n}" ${COLUMNS[n]!.sqlType}`).join(", ")})`);
  ROWS.forEach((row, i) => {
    const params: (string | null)[] = [];
    const values = row.map((v) => (v !== null && typeof v === "object" ? v.sql : (params.push(v), "?")));
    db.prepare(`INSERT INTO t VALUES (${i + 1}, ${values.join(", ")})`).run(...params);
  });
  return db;
}

/** A value as the application serves it: JSON.parse of a column with `items` (the text itself when it doesn't parse). */
function served(value: unknown, column: SqlColumn): unknown {
  if (column.items === undefined || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const db = makeTable();
const rows = (db.prepare("SELECT * FROM t ORDER BY id").all() as Record<string, unknown>[]).map((r) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "id" ? v : served(v, COLUMNS[k]!)])),
);

const fromSql = (filter: Cql2Filter): number[] => {
  const { where, params } = toSql(filter, { dialect: "sqlite", columns: COLUMNS });
  return (db.prepare(`SELECT id FROM t WHERE ${where} ORDER BY id`).all(...(params as never[])) as { id: number }[]).map((r) => r.id);
};
const fromEvaluate = (filter: Cql2Filter): number[] =>
  rows.filter((row) => toEvaluator(filter, { queryables: COLUMNS })({ properties: row }) === true).map((r) => Number(r.id));

describe("sqlite: Array Functions select exactly what evaluate selects", () => {
  it("served as the application serves them", () => {
    expect(rows[0]!.tags).toEqual(["a", "b"]);
    expect(rows[6]!.counts).toEqual([9007199254740992, 2147483647, 9007199254740991]);
    expect(rows[6]!.tags).toEqual(["é", "é", "😀", "a\u0000b", "\ud800"]);
    expect(rows[7]!.days).toBe("not json");
    expect(rows[8]!.tags).toBeInstanceOf(Uint8Array);
    expect(rows[0]!.plain).toBe('["a"]'); // no items: the text
  });

  it("every generated array filter", () => {
    const filters = generateArrayFilters(NAMES);
    expect(filters.length).toBeGreaterThan(2500);
    const wrong: string[] = [];
    for (const filter of filters) {
      const [got, expected] = [fromSql(filter), fromEvaluate(filter)];
      if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${JSON.stringify(filter)}: ${JSON.stringify(got)}, evaluate ${JSON.stringify(expected)}`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it("the SQL: one function call, the literal and the items as parameters; a literal first is the converse", () => {
    const sql = (filter: unknown) => toSql(filter as Cql2Filter, { dialect: "sqlite", columns: COLUMNS });
    expect(sql({ op: "a_contains", args: [{ property: "tags" }, ["a"]] })).toEqual({
      where: `cql2_array('a_contains', "tags", ?, ?) = 1`, params: ['["a"]', '{"type":"string"}'],
    });
    expect(sql({ op: "a_contains", args: [["a"], { property: "tags" }] }).where).toBe(`cql2_array('a_containedBy', "tags", ?, ?) = 1`);
    expect(sql({ op: "not", args: [{ op: "a_overlaps", args: [{ property: "tags" }, ["a"]] }] }).where).toBe(`NOT (cql2_array('a_overlaps', "tags", ?, ?) = 1)`);
    expect(sql({ op: "a_equals", args: [{ property: "tags" }, { property: "mixed" }] })).toEqual({
      where: `cql2_array_pair('a_equals', "tags", "mixed", ?, ?) = 1`, params: ['{"type":"string"}', "{}"],
    });
    expect(sql({ op: "a_contains", args: [{ property: "plain" }, ["a"]] }).where).toBe("NULL"); // no items: no arrays
  });

  it("the functions: NULL for no array, 1 / 0 otherwise", () => {
    const { cql2_array: array, cql2_array_pair: pair } = sqliteFunctions;
    expect(array("a_contains", '["a"]', '["a"]', null)).toBe(1);
    expect(array("a_contains", '["b"]', '["a"]', null)).toBe(0);
    for (const v of [null, "[1,]", '"a"', "5", 5, new Uint8Array([0x5b, 0x5d])]) expect(array("a_contains", v, '["a"]', null)).toBe(null);
    expect(array("a_contains", "[1]", '["1"]', null)).toBe(0); // never cast
    expect(pair("a_overlaps", '["a", 1]', "[1]", null, null)).toBe(1);
    expect(pair("a_overlaps", '["1"]', "[1]", null, null)).toBe(0);
    expect(pair("a_overlaps", '["2010-02-10"]', '["2010-02-10"]', '{"type":"string","format":"date"}', null)).toBe(1);
    expect(pair("a_overlaps", null, "[1]", null, null)).toBe(null);
  });
});
