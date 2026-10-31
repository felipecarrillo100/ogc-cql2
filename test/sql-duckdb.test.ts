/**
 * `toSql`, dialect `duckdb`. The differential test runs every generated filter on a real DuckDB table
 * (`@duckdb/node-api`, in the test process) and with `evaluate` on the rows as the application serves them
 * (`duckdbValue`): both must select exactly the same rows, also under a database whose `default_collation` and time
 * zone would otherwise change the answers. The table holds the values most likely to break that: NULLs, Unicode in NFC
 * and NFD, code points above U+FFFF, LIKE's special characters, instants with sub-millisecond fractions (before and
 * after 1970), and dates and date-times held as text.
 */
import { DuckDBConnection, DuckDBInstance, DuckDBScalarFunction, INTEGER, VARCHAR } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { toPredicate } from "ogc-cql2/evaluate";
import { duckdbFunctions, duckdbValue, toSql, type SqlColumn } from "ogc-cql2/sql";
import { validate } from "ogc-cql2/validate";

// --- The table -------------------------------------------------------------------------------------------------------

const COLUMNS: Record<string, SqlColumn> = {
  b: { type: "boolean", sqlType: "BOOLEAN" },
  i: { type: "integer", sqlType: "INTEGER" },
  big: { type: "integer", sqlType: "BIGINT" },
  d: { type: "number", sqlType: "DOUBLE" },
  amount: { type: "number", sqlType: "DECIMAL(12,2)" },
  s: { type: "string", sqlType: "VARCHAR" },
  day: { type: "string", format: "date", sqlType: "DATE" },
  at: { type: "string", format: "date-time", sqlType: "TIMESTAMP WITH TIME ZONE" },
  local_at: { type: "string", sqlType: "TIMESTAMP" },
  sday: { type: "string", sqlType: "VARCHAR" }, // dates held as text
  sat: { type: "string", sqlType: "VARCHAR" }, // date-times held as text
  label: { type: "string", sqlType: "VARCHAR", column: 'odd "name"' }, // a property mapped to an awkward column name
};
const DECLARED = Object.entries(COLUMNS).map(([name, c]) => `"${(c.column ?? name).replaceAll('"', '""')}" ${c.sqlType}`);

/** Rows as SQL literals, in the order of COLUMNS. */
const ROWS: string[][] = [
  ["TRUE", "5", "9007199254740991", "2.5", "12.34", "'Straße'", "DATE '2020-07-26'", "TIMESTAMPTZ '2023-01-01 00:00:00+00'", "TIMESTAMP '2023-01-01 10:00:00'", "'2020-07-26'", "'2023-01-01T00:00:00Z'", "'Riv'"],
  ["FALSE", "10", "-1", "-1", "0", "'STRASSE'", "DATE '2021-01-01'", "TIMESTAMPTZ '2023-01-01 00:00:00.0019+00'", "TIMESTAMP '2023-01-01 10:00:00.1239'", "'2021-01-01'", "'2023-01-01T00:00Z'", "'river'"],
  ["NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL"],
  ["TRUE", "0", "0", "0", "2.5", "'café'", "DATE '1999-12-31'", "TIMESTAMPTZ '1969-12-31 23:59:59.9995+00'", "TIMESTAMP '1969-12-31 23:59:59.9995'", "'2020-7-26'", "'2022-12-31T23:59:59.999+01:00'", "'River'"],
  ["FALSE", "-1", "1", "0.5", "5", "'cafe\u0301'", "DATE '2020-07-27'", "TIMESTAMPTZ '2022-12-31 23:00:00+00'", "TIMESTAMP '2022-12-31 23:00:00'", "'2023-02-30'", "'2023-01-01T10:00:00'", "'100%'"],
  ["TRUE", "1", "5", "10", "1", "''", "DATE '2020-07-25'", "TIMESTAMPTZ '2023-01-01 00:00:00.5+00'", "TIMESTAMP '2023-01-01 00:00:00.5'", "''", "'1969-12-31T23:59:59.999Z'", "'a_b'"],
  ["FALSE", "2", "2", "3", "3", "'😀'", "DATE '0099-07-26'", "TIMESTAMPTZ '2024-02-29 12:30:00+05:30'", "TIMESTAMP '2024-02-29 12:30:00'", "'2020-07-26T00:00:00Z'", "'not a date'", "'back\\slash'"],
  ["TRUE", "7", "7", "7", "7", "'Ελλάδα'", "DATE '2020-07-26'", "TIMESTAMPTZ '2023-01-01 01:00:00+01'", "TIMESTAMP '2023-01-01 00:00:00'", "'1999-12-31'", "'2024-02-29T12:30:00+05:30'", "''"],
  ["FALSE", "8", "8", "8", "8", "'ΕΛΛΆΔΑ'", "DATE '2020-01-01'", "TIMESTAMPTZ '2023-06-15 08:00:00+00'", "TIMESTAMP '2023-06-15 08:00:00'", "'2020-07-26'", "'2023-01-01T00:00:01Z'", "'Straße'"],
  ["TRUE", "9", "9", "9", "9", "'İstanbul'", "DATE '2022-02-02'", "TIMESTAMPTZ '2023-01-01 00:00:01+00'", "TIMESTAMP '2023-01-01 00:00:01'", "'2022-02-02'", "'2022-12-31T23:00:00Z'", "'ﬁle'"],
  ["FALSE", "4", "4", "4", "4", "'ﬁle'", "DATE '2020-07-26'", "TIMESTAMPTZ '2023-01-01 00:00:00.0005+00'", "TIMESTAMP '2023-01-01 00:00:00.0005'", "'0000-01-01'", "'2023-01-01T24:00:00Z'", "'FILE'"],
  ["TRUE", "6", "6", "6", "6", "'\uE000'", "DATE '2021-01-01'", "TIMESTAMPTZ '2023-01-01 00:00:00+00'", "TIMESTAMP '2023-01-01 10:00:00'", "'2021-01-01'", "'2023-01-01t00:00:00z'", "'a b'"],
  ["FALSE", "3", "3", "1", "0.01", "'100%'", "DATE '2020-07-26'", "TIMESTAMPTZ '2023-01-01 00:00:00.001+00'", "TIMESTAMP '2023-01-01 00:00:00.001'", "'2020-07-26'", "'2023-01-01T00:00:00.0001Z'", "'ab'"],
  ["TRUE", "11", "11", "11", "11", "'a_b'", "DATE '2023-01-01'", "TIMESTAMPTZ '2022-12-31 19:00:00-05'", "TIMESTAMP '2022-12-31 19:00:00'", "'2023-01-01'", "'2023-01-01T00:00:00-00:00'", "'a\nb'"],
  ["FALSE", "12", "12", "12", "12", "'end\\'", "DATE '2023-01-01'", "TIMESTAMPTZ '2023-01-01 00:00:00+00'", "TIMESTAMP '2023-01-01 00:00:00'", "'2023-01-01'", "'2023-01-01T00:00:00Z'", "'end\\'"],
];

/** Registers `duckdbFunctions` on a connection, as the README shows. */
function register(connection: DuckDBConnection): void {
  const types = { VARCHAR, INTEGER };
  for (const [name, f] of Object.entries(duckdbFunctions)) {
    connection.registerScalarFunction(
      DuckDBScalarFunction.create({
        name,
        returnType: types[f.returns],
        parameterTypes: f.parameters.map((t) => types[t]),
        mainFunction: (_info, input, output) => {
          const args = f.parameters.map((_, i) => input.getColumnVector(i));
          for (let row = 0; row < input.rowCount; row++) {
            output.setItem(row, f.call(...args.map((a) => a.getItem(row) as string | null)));
          }
          output.flush();
        },
      }),
    );
  }
}

async function open(settings: string[]): Promise<DuckDBConnection> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  for (const setting of settings) await connection.run(setting);
  register(connection);
  await connection.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, ${DECLARED.join(", ")})`);
  await connection.run(`INSERT INTO t VALUES ${ROWS.map((r, i) => `(${i + 1}, ${r.join(", ")})`).join(", ")}`);
  return connection;
}

const PLAIN: string[] = [];
const HOSTILE = ["SET default_collation = 'nocase'", "SET TimeZone = 'America/New_York'"];
let plain: DuckDBConnection;
let hostile: DuckDBConnection;
let served: Record<string, unknown>[] = [];

beforeAll(async () => {
  [plain, hostile] = await Promise.all([open(PLAIN), open(HOSTILE)]);
  const select = Object.entries(COLUMNS).map(([name, c]) => `${duckdbValue(c.column ?? name, c)} AS "${name}"`);
  served = (await plain.runAndReadAll(`SELECT id, ${select.join(", ")} FROM t ORDER BY id`)).getRowObjects() as Record<string, unknown>[];
});
afterAll(() => {
  plain?.closeSync();
  hostile?.closeSync();
});

async function fromSql(connection: DuckDBConnection, filter: Cql2Filter): Promise<number[]> {
  const { where, params } = toSql(filter, { dialect: "duckdb", columns: COLUMNS });
  const result = await connection.runAndReadAll(`SELECT id FROM t WHERE ${where} ORDER BY id`, params as never);
  return result.getRows().map((r) => r[0] as number);
}
const fromEvaluate = (filter: Cql2Filter): number[] =>
  served.filter(toPredicate(filter, { getProperty: (row, name) => row[name] })).map((r) => r.id as number);

// --- The generated filters -------------------------------------------------------------------------------------------

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });
const PROPERTIES = Object.keys(COLUMNS);
const LITERALS: unknown[] = [
  "Straße", "STRASSE", "café", "cafe\u0301", "", "😀", "\uE000", "Riv", "river", "a_b", "Ελλάδα", "100%", "end\\",
  "2020-07-26", "2023-01-01T00:00:00.000Z", "2023-01-01T10:00:00.000", "2023-01-01T00:00:00.001Z",
  0, 1, 2.5, 5, 10, -1, 12.34, 9007199254740991, true, false,
  { date: "2020-07-26" }, { date: "2021-01-01" }, { date: "0099-07-26" },
  { timestamp: "2023-01-01T00:00:00Z" }, { timestamp: "2022-12-31T23:00:00Z" }, { timestamp: "2023-01-01T00:00:00.5Z" },
  { timestamp: "2023-01-01T00:00:00.001Z" }, { timestamp: "1969-12-31T23:59:59.999Z" },
];
const OPS = ["=", "<>", "<", "<=", ">", ">="];
const PATTERNS = ["%", "_%", "", "Stra%", "%ss%", "%SS%", "100\\%", "a\\_b", "a_b", "%é", "ri%", "Ri_", "_", "%😀%", "% %", "end\\", "%T%", "2023%", "%.001%"];

function generate(): Cql2Filter[] {
  const leaves: unknown[] = [true, false];
  for (const name of PROPERTIES) {
    leaves.push({ op: "isNull", args: [p(name)] });
    for (const value of LITERALS) for (const op of OPS) leaves.push({ op, args: [p(name), value] });
    for (const value of LITERALS.filter((v) => typeof v === "string")) {
      for (const op of ["=", "<"]) {
        leaves.push({ op, args: [casei(p(name)), casei(value)] });
        leaves.push({ op, args: [casei(p(name)), value] });
        leaves.push({ op, args: [p(name), casei(value)] });
      }
    }
    for (const pattern of PATTERNS) {
      leaves.push({ op: "like", args: [p(name), pattern] });
      leaves.push({ op: "like", args: [casei(p(name)), casei(pattern)] });
      leaves.push({ op: "like", args: [p(name), casei(pattern)] });
    }
    leaves.push({ op: "between", args: [p(name), 0, 5] }, { op: "between", args: [p(name), -1, 2.5] });
    for (const list of [["Straße", "café"], [5, 10], [true], [{ date: "2020-07-26" }, { date: "1999-12-31" }],
      [{ timestamp: "2023-01-01T00:00:00Z" }], [0, 1]]) {
      leaves.push({ op: "in", args: [p(name), list] });
    }
    leaves.push({ op: "in", args: [casei(p(name)), [casei("strasse"), casei("ελλάδα")]] });
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

describe("DuckDB selects exactly what evaluate selects", () => {
  const filters = generate();

  for (const [label, connection] of [["plain settings", () => plain], ["nocase collation, New York time zone", () => hostile]] as const) {
    it(`${filters.length} filters on ${ROWS.length} rows (${label})`, async () => {
      expect(filters.length).toBeGreaterThan(3000);
      const differences: string[] = [];
      for (const filter of filters) {
        const sql = await fromSql(connection(), filter);
        const memory = fromEvaluate(filter);
        if (JSON.stringify(sql) !== JSON.stringify(memory)) {
          differences.push(`${JSON.stringify(filter)}\n    duckdb ${JSON.stringify(sql)}  evaluate ${JSON.stringify(memory)}`);
        }
      }
      expect(differences.slice(0, 20).join("\n")).toBe("");
    }, 120_000);
  }

  it("the test is not trivial: filters select different, non-empty sets", () => {
    const results = new Set(filters.map((f) => JSON.stringify(fromEvaluate(f))));
    expect(results.size).toBeGreaterThan(150);
  });

  it("serves values as the dialect compares them", () => {
    expect(served[1]).toEqual({
      id: 2, b: false, i: 10, big: -1, d: -1, amount: 0, s: "STRASSE", day: "2021-01-01",
      at: "2023-01-01T00:00:00.001Z", local_at: "2023-01-01T10:00:00.123", sday: "2021-01-01", sat: "2023-01-01T00:00Z",
      label: "river",
    });
    expect(served[3]!.at).toBe("1969-12-31T23:59:59.999Z");
  });
});

// --- The SQL it builds -----------------------------------------------------------------------------------------------

describe("the SQL it builds", () => {
  const sql = (filter: unknown) => toSql(filter as Cql2Filter, { dialect: "duckdb", columns: COLUMNS });

  it("$n placeholders, with the casts each column needs", () => {
    expect(sql({ op: "and", args: [{ op: ">", args: [p("i"), 5] }, { op: "=", args: [p("b"), true] }] })).toEqual({
      where: `(CAST("i" AS DOUBLE) > $1::DOUBLE) AND ("b" = $2::BOOLEAN)`,
      params: [5, true],
    });
  });

  it("text in code point order, NFC on both sides, whatever the default collation", () => {
    expect(sql({ op: "<", args: [p("s"), "café"] })).toEqual({
      where: `nfc_normalize("s") COLLATE "binary" < $1::VARCHAR`,
      params: ["café"],
    });
  });

  it("LIKE: DuckDB's own with ESCAPE; a trailing lone backslash is a backslash", () => {
    expect(sql({ op: "like", args: [p("label"), "end\\"] })).toEqual({
      where: `nfc_normalize("odd ""name""") COLLATE "binary" LIKE $1 ESCAPE '\\'`,
      params: ["end\\\\"],
    });
  });

  it("CASEI through functions that return numbers", () => {
    expect(sql({ op: "<=", args: [casei(p("s")), casei("STRASSE")] })).toEqual({
      where: `cql2_casei_cmp("s", $1::VARCHAR) <= 0`,
      params: ["strasse"],
    });
    expect(sql({ op: "in", args: [casei(p("s")), [casei("A"), casei("B")]] }).where).toBe(
      `(cql2_casei_cmp("s", $1::VARCHAR) = 0 OR cql2_casei_cmp("s", $2::VARCHAR) = 0)`,
    );
    expect(sql({ op: "like", args: [casei(p("s")), casei("Stra%")] })).toEqual({
      where: `cql2_casei_like("s", $1::VARCHAR) = 1`,
      params: ["stra%"],
    });
  });

  it("instants as epoch milliseconds; dates natively, or as day numbers from text", () => {
    expect(sql({ op: "<", args: [p("at"), { timestamp: "2023-01-01T00:00:00Z" }] })).toEqual({
      where: `floor(epoch_us("at") / 1000) < $1::DOUBLE`,
      params: [1672531200000],
    });
    expect(sql({ op: "=", args: [p("day"), { date: "2020-07-26" }] })).toEqual({ where: `"day" = $1::DATE`, params: ["2020-07-26"] });
    expect(sql({ op: "=", args: [p("sday"), { date: "1970-01-02" }] })).toEqual({ where: `cql2_day("sday") = $1::INTEGER`, params: [1] });
    expect(sql({ op: ">", args: [p("sat"), { timestamp: "1970-01-02T00:00:00.001Z" }] })).toEqual({
      where: `(CAST(cql2_instant_day("sat") AS BIGINT) * 86400000 + cql2_instant_ms("sat")) > $1::BIGINT`,
      params: [86400001],
    });
  });

  it("a literal that can't match the column's type is NULL", () => {
    expect(sql({ op: "=", args: [p("i"), true] })).toEqual({ where: "NULL::BOOLEAN", params: [] });
    expect(sql({ op: "=", args: [p("local_at"), { timestamp: "2023-01-01T00:00:00Z" }] }).where).toBe("NULL::BOOLEAN");
  });

  it("duckdbValue: what to SELECT; nothing for a type it can't compare", () => {
    expect(duckdbValue("n", { sqlType: "HUGEINT" })).toBe(`CAST("n" AS DOUBLE)`);
    expect(duckdbValue("d", { sqlType: "DATE" })).toBe(`strftime("d", '%Y-%m-%d')`);
    expect(duckdbValue("g", { sqlType: "GEOMETRY" })).toBeUndefined();
    expect(duckdbValue("l", { sqlType: "VARCHAR[]" })).toBeUndefined();
  });
});
