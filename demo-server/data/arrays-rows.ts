/**
 * The arrays table's rows as JSON text, shared by the stores that hold arrays as JSON (make-arrays-gpkg.ts for
 * GeoPackage, load-oracle.ts for Oracle): the values where engines disagree (NULL arrays, NULL elements, repeats, empty
 * arrays, `""`, `"a "`, `"A"`, NFC and NFD, `1` / `1.0`, `-0`, dates and instants as text), GDAL's pretty-printed JSON,
 * JSON that isn't an array or isn't JSON, and where engines' own JSON reading parts from JSON.parse (an integer beyond
 * 2^53, a lone surrogate, `\u0000`, `1e400`).
 */
export const COLUMNS = ["tags", "codes", "ratios", "counts", "flags", "days", "moments", "doc"] as const;
// id, title, then COLUMNS as stored (JSON text, or NULL)
export const ROWS: [number, string, ...(string | null)[]][] = [
  [1, "two strings (as GDAL writes them)", `[ "a", "b" ]`, `[ "a", "b" ]`, `[ 1.0, 2.5 ]`, `[ 1, 2 ]`, `[ true, false ]`, `[ "2010-02-10" ]`,
    `[ "2010-02-10T05:30:00.123Z" ]`, `[ "a", "b" ]`],
  [2, "repeats, another order", `["b","a","a"]`, `["b","a","a"]`, `[2.5, 1, 1]`, `[2, 1, 1]`, `[false, true, true]`, `["2010-02-10", "2010-02-10"]`,
    `["2010-02-10T05:30:00.1234Z", "2010-02-10T05:30:00.123+00:00"]`, `["b", "a", "a"]`],
  [3, "empty", `[]`, `[]`, `[]`, `[]`, `[]`, `[]`, `[]`, `[]`],
  [4, "NULL", null, null, null, null, null, null, null, null],
  [5, "NULL elements", `["a", null]`, `[null]`, `[null, 0.1]`, `[null, 1]`, `[null, true]`, `[null, "2010-02-10"]`, `[null]`, `["a", null]`],
  [6, "the equality traps", `["", "a ", "A"]`, `["1"]`, `[1.0, -0.0, 0.1]`, `[0, -1]`, `[true]`, `["1969-07-16"]`, `["1969-07-16T13:32:00Z"]`,
    `["", "a ", "A", "1", 1, true, 1.0]`],
  [7, "Unicode: NFD é, U+E000, an emoji", `["é", "", "😀"]`, `["é"]`, `[1e300, -1e300]`, `[2147483647]`, `[false]`, `["2010-02-30", "2010-02-10"]`,
    `["not a date"]`, `["é", "é"]`],
  [8, "dates and instants as strings", `["2010-02-10", "2010-02-10T05:30:00.123Z"]`, `["2010-02-10"]`, `[0]`, `[0]`, `[true]`, `["2010-02-10", "1969-07-16"]`,
    `["2010-02-10T00:00:00Z", "2012-08-10T05:30:00+00:00"]`, `["2010-02-10", "2010-02-10T05:30:00.123Z", "2012-08-10T05:30:00+00:00"]`],
  [9, "JSON that isn't an array, or isn't JSON", `"a"`, `{"not": "an array"}`, `5`, `true`, `null`, `not json`, `[1,]`, ``],
  [10, "nested, an object, out of range", `[["a"], "b"]`, `["x"]`, `[[1], 8]`, `[8]`, `[true]`, `["2010-02-11"]`, `["2010-02-11T00:00:00Z"]`,
    `[["a"], {"k": 1}, 1e400, 1e-400, "a"]`],
  [11, "the standard's mixed examples", `["a", "c"]`, `["a"]`, `[1, 8]`, `[1, 8]`, `[true]`, `["2010-02-10"]`, `["2012-08-10T05:30:00Z"]`, `["a", true, 1.0, 8]`],
  [12, "one of each", `["c"]`, `["a "]`, `[2.5]`, `[2]`, `[false]`, `["1969-07-16"]`, `["1969-07-16T13:32:00.0005Z"]`, `[false, "2012-08-10T05:30:00Z", "2010-02-10"]`],
  [13, "where SQLite's JSON reading parts from JSON.parse", String.raw`["a\u0000b", "\ud800"]`, `["b"]`, `[1e400]`, `[9007199254740993, 9007199254740991]`, `[true]`,
    `["2010-02-10"]`, `["2010-02-10T05:30:00.123Z"]`, String.raw`[9007199254740993, "\ud800"]`],
];
