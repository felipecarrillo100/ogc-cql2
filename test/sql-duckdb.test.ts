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
import { casei, generateArithmeticFilters, generateFilters, generatePropertyFilters, generateTemporalFilters, p } from "./corpus.ts";

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
  // Numbers that aren't finite: DuckDB stores them, and orders NaN above every number, as evaluate does.
  ["TRUE", "13", "13", "'NaN'::DOUBLE", "13", "'nan'", "DATE '2023-01-02'", "TIMESTAMPTZ '2023-01-02 00:00:00+00'", "TIMESTAMP '2023-01-02 00:00:00'", "'2023-01-02'", "'2023-01-02T00:00:00Z'", "'nan'"],
  ["FALSE", "14", "14", "'Infinity'::DOUBLE", "14", "'inf'", "DATE '2023-01-02'", "TIMESTAMPTZ '2023-01-02 00:00:00+00'", "TIMESTAMP '2023-01-02 00:00:00'", "'2023-01-02'", "'2023-01-02T00:00:00Z'", "'inf'"],
  ["TRUE", "15", "15", "'-Infinity'::DOUBLE", "15", "'-inf'", "DATE '2023-01-02'", "TIMESTAMPTZ '2023-01-02 00:00:00+00'", "TIMESTAMP '2023-01-02 00:00:00'", "'2023-01-02'", "'2023-01-02T00:00:00Z'", "'-inf'"],
  // Accents: Portuguese, Spanish, Vietnamese (two marks, decomposed), Polish, Danish, Japanese voicing marks.
  ["TRUE", "16", "16", "16", "16", "'São Paulo'", "DATE '2023-01-03'", "TIMESTAMPTZ '2023-01-03 00:00:00+00'", "TIMESTAMP '2023-01-03 00:00:00'", "'2023-01-03'", "'2023-01-03T00:00:00Z'", "'SÃO PAULO'"],
  ["FALSE", "17", "17", "17", "17", "'año'", "DATE '2023-01-03'", "TIMESTAMPTZ '2023-01-03 00:00:00+00'", "TIMESTAMP '2023-01-03 00:00:00'", "'2023-01-03'", "'2023-01-03T00:00:00Z'", "'ano'"],
  ["TRUE", "18", "18", "18", "18", "'Vie\u0323\u0302t Nam'", "DATE '2023-01-03'", "TIMESTAMPTZ '2023-01-03 00:00:00+00'", "TIMESTAMP '2023-01-03 00:00:00'", "'2023-01-03'", "'2023-01-03T00:00:00Z'", "'VIET NAM'"],
  ["FALSE", "19", "19", "19", "19", "'Łódź'", "DATE '2023-01-03'", "TIMESTAMPTZ '2023-01-03 00:00:00+00'", "TIMESTAMP '2023-01-03 00:00:00'", "'2023-01-03'", "'2023-01-03T00:00:00Z'", "'Øresund'"],
  ["TRUE", "20", "20", "20", "20", "'はじめ'", "DATE '2023-01-03'", "TIMESTAMPTZ '2023-01-03 00:00:00+00'", "TIMESTAMP '2023-01-03 00:00:00'", "'2023-01-03'", "'2023-01-03T00:00:00Z'", "'はしめ'"],
  // Numbers that need all 17 significant digits: DuckDB-WASM 1.32.0 binds such a number parameter one unit off, and
  // reads such a SQL literal (a DECIMAL) one unit off too, so the table gets them as text, which it reads exactly.
  ["FALSE", "21", "21", "'0.9653517007827759'::DOUBLE", "21", "'x'", "DATE '2023-01-04'", "TIMESTAMPTZ '2023-01-04 00:00:00+00'", "TIMESTAMP '2023-01-04 00:00:00'", "'2023-01-04'", "'2023-01-04T00:00:00Z'", "'x'"],
  ["TRUE", "22", "22", "'-174.71493244171143'::DOUBLE", "22", "'y'", "DATE '2023-01-04'", "TIMESTAMPTZ '2023-01-04 00:00:00+00'", "TIMESTAMP '2023-01-04 00:00:00'", "'2023-01-04'", "'2023-01-04T00:00:00Z'", "'y'"],
  ["FALSE", "23", "23", "'206289291381835.94'::DOUBLE", "23", "'z'", "DATE '2023-01-04'", "TIMESTAMPTZ '2023-01-04 00:00:00+00'", "TIMESTAMP '2023-01-04 00:00:00'", "'2023-01-04'", "'2023-01-04T00:00:00Z'", "'z'"],
  // Infinite dates and timestamps: DuckDB stores them (CQL2 has none), served as `infinity`, which is no date.
  ["TRUE", "24", "24", "24", "24", "'∞'", "DATE 'infinity'", "TIMESTAMPTZ 'infinity'", "TIMESTAMP 'infinity'", "'2023-01-04'", "'infinity'", "'∞'"],
  ["FALSE", "25", "25", "25", "25", "'-∞'", "DATE '-infinity'", "TIMESTAMPTZ '-infinity'", "TIMESTAMP '-infinity'", "'-infinity'", "'2023-01-04T00:00:00Z'", "'-∞'"],
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

const generate = () => generateFilters(Object.keys(COLUMNS));

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
    // Infinity is served as its text: no date (NULL in comparisons), not NULL itself.
    const [up, down] = ["∞", "-∞"].map((label) => served.find((r) => r.label === label)!);
    expect([up!.day, up!.at, up!.local_at, down!.day, down!.at, down!.local_at]).toEqual(["infinity", "infinity", "infinity", "-infinity", "-infinity", "-infinity"]);
  });
});

describe("Property-Property Comparisons: DuckDB selects exactly what evaluate selects, given the columns as queryables", () => {
  const all = generatePropertyFilters(Object.keys(COLUMNS));
  const refused = (filter: Cql2Filter) => {
    try {
      toSql(filter, { dialect: "duckdb", columns: COLUMNS });
      return false;
    } catch {
      return true;
    }
  };
  const filters = all.filter((f) => !refused(f));
  const fromMemory = (filter: Cql2Filter): number[] =>
    served.filter(toPredicate(filter, { getProperty: (row, name) => row[name], queryables: COLUMNS })).map((r) => r.id as number);

  for (const [label, connection] of [["plain settings", () => plain], ["nocase collation, New York time zone", () => hostile]] as const) {
    it(`${filters.length} filters on ${ROWS.length} rows (${label})`, async () => {
      expect(filters.length).toBeGreaterThan(3000);
      const differences: string[] = [];
      for (const filter of filters) {
        const sql = await fromSql(connection(), filter);
        const memory = fromMemory(filter);
        if (JSON.stringify(sql) !== JSON.stringify(memory)) {
          differences.push(`${JSON.stringify(filter)}\n    duckdb ${JSON.stringify(sql)}  evaluate ${JSON.stringify(memory)}`);
        }
      }
      expect(differences.slice(0, 20).join("\n")).toBe("");
    }, 120_000);
  }

  it("what toSql refuses (two columns whose types can't be compared), validate refuses with the queryables", () => {
    const refusedOnes = all.filter(refused);
    expect(refusedOnes.length).toBeGreaterThan(100);
    for (const f of refusedOnes) expect(validate(f, { queryables: COLUMNS }).valid, JSON.stringify(f)).toBe(false);
  });

  it("the test is not trivial: filters select different, non-empty sets", () => {
    const results = new Set(filters.map((f) => JSON.stringify(fromMemory(f))));
    expect(results.size).toBeGreaterThan(150);
  });
});

describe("Arithmetic Expressions: DuckDB selects exactly what evaluate selects", () => {
  const filters = generateArithmeticFilters(Object.keys(COLUMNS));

  // A measurement, not a gate: a power whose exact result isn't a double is the engine's pow, which may differ from
  // V8's in the last bit (README, "Arithmetic"); a comparison exactly on that value may then differ.
  it("non-exact powers: how many comparisons differ from evaluate (reported)", async (context) => {
    const powers = Object.keys(COLUMNS).flatMap((name) => [0.5, 1.5, -0.5, 1 / 3].flatMap((e) =>
      [">", "<", "="].map((op) => ({ op, args: [{ op: "^", args: [p(name), e] }, { op: "^", args: [p(name), e] }] }) as unknown as Cql2Filter)));
    let differ = 0;
    for (const filter of powers) if (JSON.stringify(await fromSql(plain, filter)) !== JSON.stringify(fromMemory(filter))) differ++;
    context.annotate(`${differ} of ${powers.length} comparisons of non-exact powers differ from evaluate`);
  });
  const fromMemory = (filter: Cql2Filter): number[] =>
    served.filter(toPredicate(filter, { getProperty: (row, name) => row[name] })).map((r) => r.id as number);

  for (const [label, connection] of [["plain settings", () => plain], ["nocase collation, New York time zone", () => hostile]] as const) {
    it(`${filters.length} filters on ${ROWS.length} rows (${label})`, async () => {
      expect(filters.length).toBeGreaterThan(3000);
      const differences: string[] = [];
      for (const filter of filters) {
        const sql = await fromSql(connection(), filter);
        const memory = fromMemory(filter);
        if (JSON.stringify(sql) !== JSON.stringify(memory)) {
          differences.push(`${JSON.stringify(filter)}\n    duckdb ${JSON.stringify(sql)}  evaluate ${JSON.stringify(memory)}`);
        }
      }
      expect(differences.slice(0, 20).join("\n")).toBe("");
    }, 120_000);
  }
});

describe("Temporal Functions: DuckDB selects exactly what evaluate selects, given the columns as queryables", () => {
  // Literals among the table's values, sub-millisecond ones included.
  const filters = generateTemporalFilters(["day", "at", "sday", "sat"], ["2020-07-26", "2021-01-01", "2023-01-01", "1999-12-31"],
    ["2023-01-01T00:00:00Z", "2023-01-01T00:00:00.001Z", "1969-12-31T23:59:59.999Z", "2022-12-31T23:00:00Z", "2023-01-01T00:00:00.0005Z"]);
  const fromMemory = (filter: Cql2Filter): number[] =>
    served.filter(toPredicate(filter, { getProperty: (row, name) => row[name], queryables: COLUMNS })).map((r) => r.id as number);

  for (const [label, connection] of [["plain settings", () => plain], ["nocase collation, New York time zone", () => hostile]] as const) {
    it(`${filters.length} filters on ${ROWS.length} rows (${label})`, async () => {
      expect(filters.length).toBeGreaterThan(3000);
      const differences: string[] = [];
      for (const filter of filters) {
        const sql = await fromSql(connection(), filter);
        const memory = fromMemory(filter);
        if (JSON.stringify(sql) !== JSON.stringify(memory)) {
          differences.push(`${JSON.stringify(filter)}\n    duckdb ${JSON.stringify(sql)}  evaluate ${JSON.stringify(memory)}`);
        }
      }
      expect(differences.slice(0, 20).join("\n")).toBe("");
    }, 240_000);
  }

  it("the test is not trivial: filters select different, non-empty sets", () => {
    const results = new Set(filters.map((f) => JSON.stringify(fromMemory(f))));
    expect(results.size).toBeGreaterThan(120); // 139 measured
  });
});

// --- validate with queryables against evaluate -------------------------------------------------------------------

describe("validate with the table's queryables refuses only filters evaluate can't match", () => {
  const leaves = generate().filter((f) => typeof f === "object" && !["and", "or", "not"].includes(f.op));
  const isMismatch = (f: Cql2Filter) => {
    const result = validate(f, { queryables: COLUMNS });
    return !result.valid && result.problems.every((x) => x.code === "type-mismatch");
  };
  // GeoJSON has no date type: dates and instants are served as strings. So, without queryables, evaluate casts between
  // the two, which CQL2 permits (/per/basic-cql2/type-casts): a date or date-time property compared with a string
  // (or LIKE) is compared as its text; a text property compared with a date or timestamp is read as one.
  const castsStringAndDate = (f: Cql2Filter) => {
    const [subject, value] = (f as unknown as { args: unknown[] }).args as [unknown, unknown];
    let inner = subject as { property?: string; args?: unknown[] };
    while (inner.property === undefined) inner = inner.args![0] as typeof inner; // inside CASEI / ACCENTI
    const column = COLUMNS[inner.property]!;
    const literals = Array.isArray(value) ? value : [value];
    const instant = (l: unknown) => typeof l === "object" && l !== null && ("date" in l || "timestamp" in l);
    if (column.type === "string" && column.format !== undefined) return literals.every((l) => !instant(l));
    return column.type === "string" && literals.every(instant);
  };

  it("a refused leaf selects no row, and neither does its NOT (it is NULL), except through those casts", () => {
    const refused = leaves.filter(isMismatch);
    expect(refused.length).toBeGreaterThan(1000);
    const selecting = refused.filter((f) => fromEvaluate(f).length > 0 || fromEvaluate({ op: "not", args: [f] } as Cql2Filter).length > 0);
    expect(selecting.filter((f) => !castsStringAndDate(f)).map((f) => JSON.stringify(f)).slice(0, 10)).toEqual([]);
  });
});

// --- The SQL it builds -----------------------------------------------------------------------------------------------

describe("the SQL it builds", () => {
  const sql = (filter: unknown) => toSql(filter as Cql2Filter, { dialect: "duckdb", columns: COLUMNS });

  it("$n placeholders, with the casts each column needs", () => {
    expect(sql({ op: "and", args: [{ op: ">", args: [p("i"), 5] }, { op: "=", args: [p("b"), true] }] })).toEqual({
      where: `(CAST("i" AS DOUBLE) > $1::DOUBLE) AND ("b" = $2::BOOLEAN)`,
      params: ["5", true], // numbers as text: DuckDB-WASM binds some number parameters one unit off
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

  it("instants as epoch milliseconds; dates natively (infinity as NULL), or as day numbers from text", () => {
    expect(sql({ op: "<", args: [p("at"), { timestamp: "2023-01-01T00:00:00Z" }] })).toEqual({
      where: `floor(epoch_us("at") / 1000) < $1::DOUBLE`,
      params: ["1672531200000"], // as text: @duckdb/node-api 1.4 binds a number as a 32-bit INTEGER
    });
    // An infinite date is NULL: FALSE selects the same rows outside a NOT, TRUE inside one; the column keeps its index.
    expect(sql({ op: "=", args: [p("day"), { date: "2020-07-26" }] })).toEqual({ where: `("day" = $1::DATE AND isfinite("day"))`, params: ["2020-07-26"] });
    expect(sql({ op: "not", args: [{ op: "=", args: [p("day"), { date: "2020-07-26" }] }] }).where).toBe(`NOT (("day" = $1::DATE OR NOT isfinite("day")))`);
    expect(sql({ op: "=", args: [p("sday"), { date: "1970-01-02" }] })).toEqual({ where: `cql2_day("sday") = $1::INTEGER`, params: [1] });
    expect(sql({ op: ">", args: [p("sat"), { timestamp: "1970-01-02T00:00:00.001Z" }] })).toEqual({
      where: `(CAST(cql2_instant_day("sat") AS BIGINT) * 86400000 + cql2_instant_ms("sat")) > $1::BIGINT`,
      params: ["86400001"],
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
