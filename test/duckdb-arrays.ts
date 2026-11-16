/**
 * Array Functions in `toSql`'s `duckdb` dialect (since 1.6.0), run once per DuckDB engine, each in a test file (so a
 * process) of its own: DuckDB 2.0 (`@duckdb/node-api`), and 1.5.4 (`@duckdb/node-api-1.5`), the engine of
 * DuckDB-WASM. Every generated array filter selects on a real table what `evaluate` selects on the rows as the
 * application serves them (`duckdbValue`), with and without `items`, also under a `default_collation` and a time zone
 * that would otherwise change the answers. The table holds the values where engines disagree: NULL lists, NULL
 * elements, repeats, empty lists, `""`, `"a "`, `"A"`, NFC and NFD, `1` / `1.0`, `-0`, infinite dates and instants,
 * sub-millisecond instants, dates and instants held as text, a list of lists, and a fixed-size ARRAY.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { toEvaluator } from "ogc-cql2/evaluate";
import { duckdbFunctions, duckdbValue, toSql, type SqlColumn } from "ogc-cql2/sql";
import { generateArrayFilters } from "./corpus.ts";

/** What the suite uses of `@duckdb/node-api`, the same in both versions. */
interface Connection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string, params?: never): Promise<{ getRows(): unknown[][]; getRowObjects(): Record<string, unknown>[] }>;
  registerScalarFunction(f: unknown): void;
  closeSync(): void;
}
export interface Engine {
  readonly DuckDBInstance: { create(path: string): Promise<{ connect(): Promise<Connection> }> };
  readonly DuckDBScalarFunction: { create(options: unknown): unknown };
  readonly VARCHAR: unknown;
  readonly INTEGER: unknown;
}

/** The columns with their elements' queryables (`items`), as an application declares them. */
const TYPED: Record<string, SqlColumn> = {
  tags: { sqlType: "VARCHAR[]", items: { type: "string" } },
  ratios: { sqlType: "DOUBLE[]", items: { type: "number" } },
  counts: { sqlType: "INTEGER[]", items: { type: "integer" } },
  flags: { sqlType: "BOOLEAN[]", items: { type: "boolean" } },
  days: { sqlType: "DATE[]", items: { type: "string", format: "date" } },
  moments: { sqlType: "TIMESTAMP WITH TIME ZONE[]", items: { type: "string", format: "date-time" } },
  texts: { sqlType: "VARCHAR[]", items: { type: "string" } }, // dates and instants held as text
  nested: { sqlType: "VARCHAR[][]", items: {} },
  pair: { sqlType: "VARCHAR[2]", items: { type: "string" } }, // a fixed-size ARRAY
};
/** The same columns as their declared types alone say. */
const UNTYPED: Record<string, SqlColumn> = Object.fromEntries(Object.entries(TYPED).map(([name, c]) => [name, { sqlType: c.sqlType }]));

const D = (d: string) => `DATE '${d}'`;
const T = (t: string) => `TIMESTAMPTZ '${t}'`;
/** Rows as SQL literals, in the order of TYPED. */
const ROWS: string[][] = [
  ["['a','b']", "[1, 2.5]", "[1, 2]", "[true, false]", `[${D("2010-02-10")}]`, `[${T("2010-02-10 05:30:00.123+00")}]`, "['2010-02-10']", "[['a'], ['b','c']]", "['a','b']"],
  ["['b','a','a']", "[2.5, 1, 1]", "[2, 1, 1]", "[false, true, true]", `[${D("2010-02-10")}, ${D("2010-02-10")}]`, `[${T("2010-02-10 05:30:00.1234+00")}, ${T("2010-02-10 05:30:00.123+00")}]`, "['2010-02-10T05:30:00.123Z']", "[]", "['b','a']"],
  ["[]", "[]", "[]", "[]", "CAST([] AS DATE[])", "CAST([] AS TIMESTAMPTZ[])", "[]", "[[]]", "['x', NULL]"],
  ["NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL"],
  ["['a', NULL]", "[NULL, 0.1]", "[NULL, 1]", "[NULL, true]", `[NULL, ${D("2010-02-10")}]`, `[NULL::TIMESTAMPTZ]`, "[NULL::VARCHAR]", "[NULL::VARCHAR[]]", "[NULL::VARCHAR, NULL::VARCHAR]"],
  ["['', 'a ', 'A']", "[1.0, -0.0, 0.1]", "[0, -1]", "[true]", `[${D("1969-07-16")}]`, `[${T("1969-07-16 13:32:00+00")}]`, "['1969-07-16', '1']", "[['a', NULL]]", "['A', 'a ']"],
  ["['é', '', '😀']", "[1e300, -1e300]", "[2147483647]", "[false]", `['infinity'::DATE, ${D("2010-02-10")}]`, `['infinity'::TIMESTAMPTZ]`, "['é']", "[['é']]", "['é', 'é']"],
  ["['2010-02-10', '2010-02-10T05:30:00.123Z']", "[0]", "[0]", "[true]", `[${D("2010-02-10")}, ${D("1969-07-16")}]`, `[${T("2010-02-10 00:00:00+00")}, ${T("2012-08-10 05:30:00+00")}]`, "['2012-08-10T05:30:00+00:00', 'not a date']", "[['2010-02-10']]", "['2010-02-10', 'a']"],
  ["['a','c']", "[1, 8]", "[1, 8]", "[true]", `[${D("2010-02-10")}]`, `[${T("2012-08-10 05:30:00+00")}]`, "['a', '1969-07-16T13:32:00Z']", "[['a'], ['c']]", "['a', 'c']"],
  ["['c']", "[2.5]", "[2]", "[false]", `[${D("1969-07-16")}]`, `[${T("1969-07-16 13:32:00.0005+00")}]`, "['2010-02-10T05:30:00.1239Z']", "[['c']]", "['c', 'c']"],
];

/** Registers `duckdbFunctions` on a connection, as the README shows. */
function register(engine: Engine, connection: Connection): void {
  const types = { VARCHAR: engine.VARCHAR, INTEGER: engine.INTEGER };
  for (const [name, f] of Object.entries(duckdbFunctions)) {
    connection.registerScalarFunction(
      engine.DuckDBScalarFunction.create({
        name,
        returnType: types[f.returns],
        parameterTypes: f.parameters.map((t) => types[t]),
        mainFunction: (_info: unknown, input: any, output: any) => {
          const args = f.parameters.map((_, i) => input.getColumnVector(i));
          for (let row = 0; row < input.rowCount; row++) output.setItem(row, f.call(...args.map((a) => a.getItem(row) as string | null)));
          output.flush();
        },
      }),
    );
  }
}

/** A DuckDB value as an application serves it: a LIST as an array (`@duckdb/node-api` gives `{ items }`). */
const plainValue = (v: unknown): unknown =>
  v !== null && typeof v === "object" && Array.isArray((v as { items?: unknown }).items) ? (v as { items: unknown[] }).items.map(plainValue) : v;

export function duckdbArraysSuite(name: string, engine: Engine): void {
  const names = Object.keys(TYPED);
  let plain: Connection;
  let hostile: Connection;
  let served: Record<string, unknown>[] = [];
  const open = async (settings: string[]) => {
    const c = await (await engine.DuckDBInstance.create(":memory:")).connect();
    for (const s of settings) await c.run(s);
    register(engine, c);
    await c.run(`CREATE TABLE t (id INTEGER, ${names.map((n) => `"${n}" ${TYPED[n]!.sqlType}`).join(", ")})`);
    await c.run(`INSERT INTO t VALUES ${ROWS.map((r, i) => `(${i + 1}, ${r.join(", ")})`).join(", ")}`);
    return c;
  };
  beforeAll(async () => {
    [plain, hostile] = await Promise.all([open([]), open(["SET default_collation = 'nocase'", "SET TimeZone = 'America/New_York'"])]);
    const select = names.map((n) => `${duckdbValue(n, TYPED[n]!)} AS "${n}"`).join(", ");
    served = (await plain.runAndReadAll(`SELECT id, ${select} FROM t ORDER BY id`)).getRowObjects()
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plainValue(v)])));
  });
  afterAll(() => {
    plain?.closeSync();
    hostile?.closeSync();
  });

  const fromSql = async (c: Connection, filter: Cql2Filter, columns: Record<string, SqlColumn>): Promise<number[]> => {
    const { where, params } = toSql(filter, { dialect: "duckdb", columns });
    return (await c.runAndReadAll(`SELECT id FROM t WHERE ${where} ORDER BY id`, params as never)).getRows().map((r) => Number(r[0]));
  };
  const fromEvaluate = (filter: Cql2Filter, queryables?: Record<string, SqlColumn>): number[] =>
    served.filter((row) => toEvaluator(filter, queryables ? { queryables } : {})({ properties: row }) === true).map((r) => Number(r.id));

  describe(`${name}: Array Functions select exactly what evaluate selects`, () => {
    it("served as lists, each element as the scalar rules serve it", () => {
      const row = (id: number) => served[id - 1]!;
      expect(row(1).moments).toEqual(["2010-02-10T05:30:00.123Z"]);
      expect(row(3).tags).toEqual([]);
      expect(row(4).tags).toBe(null);
      expect(row(5).tags).toEqual(["a", null]);
      expect(row(7).days).toEqual(["infinity", "2010-02-10"]);
      expect(row(1).nested).toEqual([["a"], ["b", "c"]]);
      expect(row(1).counts).toEqual([1, 2]);
    });

    it.for([
      ["with items, as the queryables say", TYPED, TYPED],
      ["without items, by the declared types", UNTYPED, undefined],
    ] as const)("every generated array filter, %s, also under a nocase collation and another time zone", { timeout: 600_000 }, async ([, columns, queryables]) => {
      const filters = generateArrayFilters(names);
      expect(filters.length).toBeGreaterThan(3000);
      const wrong: string[] = [];
      for (const filter of filters) {
        const expected = fromEvaluate(filter, queryables);
        for (const [label, c] of [["plain", plain], ["hostile", hostile]] as const) {
          const got = await fromSql(c, filter, columns);
          if (JSON.stringify(got) !== JSON.stringify(expected)) wrong.push(`${label} ${JSON.stringify(filter)}: ${JSON.stringify(got)}, evaluate ${JSON.stringify(expected)}`);
        }
      }
      expect(wrong.slice(0, 5)).toEqual([]);
    });
  });
}
