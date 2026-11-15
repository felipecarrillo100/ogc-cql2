/**
 * Writes arrays.parquet (GeoParquet: DuckDB with its spatial extension writes the `geo` metadata): the arrays table
 * of arrays.sql in DuckDB's own types, for the duckdb dialect's array functions. One LIST column per kind of element,
 * and a list of lists, with the values where engines disagree: NULL lists, NULL elements, repeats, empty lists, `""`,
 * `"a "`, `"A"`, NFC and NFD, `1` / `1.0`, `-0`, infinite dates and instants, sub-millisecond instants, dates and
 * instants held as text. Usage, from demo-server: `node data/make-arrays-parquet.ts`.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { fileURLToPath } from "node:url";

const D = (d: string) => `DATE '${d}'`;
const T = (t: string) => `TIMESTAMPTZ '${t}'`;
// id, title, tags, codes, ratios, counts, flags, days, moments, nested, x, y
const ROWS: string[][] = [
  ["1", "'two strings'", "['a','b']", "['a','b']", "[1, 2.5]", "[1, 2]", "[true, false]", `[${D("2010-02-10")}]`, `[${T("2010-02-10 05:30:00.123+00")}]`, "[['a'], ['b', 'c']]", "0", "0"],
  ["2", "'repeats, another order'", "['b','a','a']", "['b','a','a']", "[2.5, 1, 1]", "[2, 1, 1]", "[false, true, true]", `[${D("2010-02-10")}, ${D("2010-02-10")}]`,
    `[${T("2010-02-10 05:30:00.1234+00")}, ${T("2010-02-10 05:30:00.123+00")}]`, "[]", "1", "1"],
  ["3", "'empty'", "[]", "[]", "[]", "[]", "[]", "CAST([] AS DATE[])", "CAST([] AS TIMESTAMPTZ[])", "[[]]", "2", "2"],
  ["4", "'NULL'", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "3", "3"],
  ["5", "'NULL elements'", "['a', NULL]", "[NULL::VARCHAR]", "[NULL, 0.1]", "[NULL, 1]", "[NULL, true]", `[NULL, ${D("2010-02-10")}]`, "[NULL::TIMESTAMPTZ]", "[NULL::VARCHAR[]]", "4", "4"],
  ["6", "'the equality traps'", "['', 'a ', 'A']", "['1']", "[1.0, -0.0, 0.1]", "[0, -1]", "[true]", `[${D("1969-07-16")}]`, `[${T("1969-07-16 13:32:00+00")}]`, "[['a', NULL]]", "5", "5"],
  ["7", "'Unicode: NFD é, U+E000, an emoji'", "['é', '', '😀']", "['é']", "[1e300, -1e300]", "[2147483647]", "[false]", `['infinity'::DATE, ${D("2010-02-10")}]`,
    "['infinity'::TIMESTAMPTZ]", "[['é']]", "6", "6"],
  ["8", "'dates and instants as strings'", "['2010-02-10', '2010-02-10T05:30:00.123Z']", "['2010-02-10']", "[0]", "[0]", "[true]", `[${D("2010-02-10")}, ${D("1969-07-16")}]`,
    `[${T("2010-02-10 00:00:00+00")}, ${T("2012-08-10 05:30:00+00")}]`, "[['2010-02-10']]", "7", "7"],
  ["9", "'a list of lists'", "['x']", "['x']", "[8]", "[8]", "[true]", `[${D("2010-02-11")}]`, `[${T("2010-02-11 00:00:00+00")}]`, "[['a', 'b'], ['c', 'd']]", "8", "8"],
  ["10", "'text that is no date'", "['not a date', '2010-02-30']", "['x']", "[8]", "[8]", "[true]", `[${D("2010-02-11")}]`, `[${T("2010-02-11 00:00:00+00")}]`, "[['x']]", "9", "9"],
  ["11", "'the standard''s mixed examples'", "['a', 'c']", "['a']", "[1, 8]", "[1, 8]", "[true]", `[${D("2010-02-10")}]`, `[${T("2012-08-10 05:30:00+00")}]`, "[['a'], ['c']]", "10", "10"],
  ["12", "'one of each'", "['c']", "['a ']", "[2.5]", "[2]", "[false]", `[${D("1969-07-16")}]`, `[${T("1969-07-16 13:32:00.0005+00")}]`, "[['c']]", "11", "11"],
  ["13", "'instants as text'", "['2012-08-10T05:30:00+00:00', '1969-07-16T13:32:00Z']", "['b']", "[1, 2.5]", "[1]", "[true]", `[${D("2010-02-10")}]`,
    `[${T("2010-02-10 05:30:00.123+00")}]`, "[['b']]", "12", "12"],
];

const out = fileURLToPath(new URL("arrays.parquet", import.meta.url));
const connection = await (await DuckDBInstance.create(":memory:")).connect();
await connection.run("INSTALL spatial");
await connection.run("LOAD spatial");
await connection.run(`CREATE TABLE arrays (id INTEGER, title VARCHAR, tags VARCHAR[], codes VARCHAR[], ratios DOUBLE[], counts INTEGER[],
  flags BOOLEAN[], days DATE[], moments TIMESTAMPTZ[], nested VARCHAR[][], x DOUBLE, y DOUBLE)`);
await connection.run(`INSERT INTO arrays VALUES ${ROWS.map((r) => `(${r.join(", ")})`).join(",\n  ")}`);
await connection.run(`COPY (SELECT * EXCLUDE (x, y), ST_Point(x, y) AS geometry FROM arrays ORDER BY id) TO '${out.replaceAll("'", "''")}' (FORMAT parquet)`);
const n = (await connection.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${out.replaceAll("'", "''")}')`)).getRowObjects()[0]!.n;
console.log(`arrays.parquet: ${n} rows`);
connection.closeSync();
