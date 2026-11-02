/**
 * The awkward-values table of the SQLite differential test (`sql.test.ts`), typed the GeoPackage way: NULLs, values
 * of another type than declared (which GeoPackage readers must allow for), booleans as 0 / 1, date-times with and
 * without seconds or offsets, Unicode in NFC and NFD, code points above U+FFFF, and LIKE's special characters. Also
 * used by the Property-Property Comparisons tests.
 */
import type { SqlColumn } from "ogc-cql2/sql";

export const COLUMNS: Record<string, SqlColumn> = {
  b: { type: "boolean" },
  i: { type: "integer" },
  d: { type: "number" },
  s: { type: "string" },
  day: { type: "string", format: "date" },
  ts: { type: "string", format: "date-time" },
  x: {}, // a column whose values' types aren't known in advance
  label: { type: "string", column: 'odd "name"' }, // a property mapped to a column with an awkward name
};

export const ROWS: Record<string, unknown>[] = [
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

/** A row as an application reads it from the table: GeoPackage's BOOLEAN 0 / 1 become false / true. */
export function readRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if (row.b === 0) out.b = false;
  if (row.b === 1) out.b = true;
  return out;
}
