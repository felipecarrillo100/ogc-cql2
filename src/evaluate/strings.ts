/**
 * How a value is read for comparison: shared by `evaluate` and by the SQL functions of `ogc-cql2/sql`, so both
 * decide every comparison with the same code. Internal to the package.
 */
import type { Fold } from "../core/folds.js";
import { ACCENT_MARKS } from "./accentMarks.js";
import { CASE_FOLDING } from "./caseFolding.js";

// --- Case folding --------------------------------------------------------------------------------------------------

let folding: Map<number, string> | undefined;

/** Decodes the generated table (scripts/gen-case-folding.mjs) on first use. */
function foldingTable(): Map<number, string> {
  if (folding) return folding;
  folding = new Map();
  for (const token of CASE_FOLDING.split(";")) {
    const colon = token.indexOf(":");
    if (colon >= 0) {
      const to = token.slice(colon + 1).split(" ").map((h) => parseInt(h, 16));
      folding.set(parseInt(token.slice(0, colon), 16), String.fromCodePoint(...to));
    } else {
      const [start, count, stride, delta] = token.split(",").map((h) => parseInt(h, 16)) as [number, number, number, number];
      for (let i = 0; i < count; i++) folding.set(start + i * stride, String.fromCodePoint(start + i * stride + delta));
    }
  }
  return folding;
}

/** The case-folding table's entries, as [code point, folded text], for the PostgreSQL functions of `ogc-cql2/sql`. */
export function caseFoldingEntries(): [number, string][] {
  return [...foldingTable()].sort((a, b) => a[0] - b[0]);
}

/** Unicode full case folding (CaseFolding 15.0.0, statuses C and F). ASCII folds to lower case. */
function caseFold(text: string): string {
  if (/^[\x00-\x7F]*$/.test(text)) return text.toLowerCase();
  const table = foldingTable();
  let out = "";
  for (const char of text) out += table.get(char.codePointAt(0)!) ?? char;
  return out;
}

/** A string's comparison key: NFC. */
export const plainKey = (text: string): string => text.normalize("NFC");

/** A string's comparison key under CASEI: its canonical caseless form, recomposed to NFC. */
export const caseiKey = (text: string): string => caseFold(text.normalize("NFD")).normalize("NFC");

// --- Accent stripping ----------------------------------------------------------------------------------------------

let marks: Set<number> | undefined;

/** Decodes the generated table (scripts/gen-accent-marks.mjs) on first use. */
function marksTable(): Set<number> {
  if (marks) return marks;
  marks = new Set();
  for (const token of ACCENT_MARKS.split(";")) {
    const [start, count] = token.split(",").map((h) => parseInt(h, 16)) as [number, number];
    for (let i = 0; i < count; i++) marks.add(start + i);
  }
  return marks;
}

/** The marks ACCENTI removes, as code points, for the PostgreSQL functions of `ogc-cql2/sql`. */
export function accentMarkEntries(): number[] {
  return [...marksTable()].sort((a, b) => a - b);
}

/**
 * A string's comparison key under ACCENTI: canonical decomposition, the nonspacing marks removed (Unicode 15.0.0,
 * category Mn, except the Japanese voicing marks U+3099 and U+309A), recomposed to NFC.
 */
export function accentiKey(text: string): string {
  const decomposed = text.normalize("NFD");
  if (/^[\x00-\x7F]*$/.test(decomposed)) return decomposed;
  const table = marksTable();
  let out = "";
  for (const char of decomposed) if (!table.has(char.codePointAt(0)!)) out += char;
  return out.normalize("NFC");
}

/** A string's comparison key under the folds, applied in order (the innermost function first); none: NFC. */
export function foldKey(text: string, folds: readonly Fold[]): string {
  let key = folds.length === 0 ? plainKey(text) : text;
  for (const fold of folds) key = fold === "casei" ? caseiKey(key) : accentiKey(key);
  return key;
}

/**
 * Two strings in Unicode code point order: negative, zero or positive. JavaScript's `<` compares UTF-16 code units,
 * which puts U+E000…U+FFFF after the characters beyond U+FFFF (stored as surrogates). The order of a binary SQL
 * comparison on UTF-8 is code point order, so both use this.
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      // Surrogates (U+D800…U+DFFF) stand for code points above U+FFFF: move them above U+E000…U+FFFF.
      const fix = (c: number) => (c >= 0xd800 && c <= 0xdfff ? c + 0x2000 : c >= 0xe000 ? c - 0x800 : c);
      return fix(x) - fix(y);
    }
  }
  return a.length - b.length;
}

// --- Dates and instants --------------------------------------------------------------------------------------------

// Strict, and the same in every engine (the PostgreSQL functions of `ogc-cql2/sql` mirror these rules): a day must
// exist (years 0001-9999), hours are 00-23, minutes and seconds 00-59, an offset at most ±23:59. JavaScript's
// Date.parse is lenient (it turns 2023-02-30 into 2 March, and accepts 24:00), so it is not used for strings.
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

/** Whether year-month-day exists in the proleptic Gregorian calendar, years 1 to 9999. */
export function isRealDay(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** A value as a calendar day (`YYYY-MM-DD`): a string of that form that exists, or a `Date`'s UTC day; else `undefined`. */
export function dayOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    const m = DAY.exec(value);
    return m && isRealDay(+m[1]!, +m[2]!, +m[3]!) ? value : undefined;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return undefined;
}

/**
 * A value as an instant, in epoch milliseconds: an ISO 8601 date-time string with `Z` or an offset that exists
 * (seconds optional, a fraction truncated to milliseconds), or a `Date`; else `undefined`.
 */
export function instantOf(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value !== "string") return undefined;
  const m = INSTANT.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number) as number[];
  const offsetHours = m[8] ? Number(m[9]) : 0;
  const offsetMinutes = m[8] ? Number(m[10]) : 0;
  if (!isRealDay(year!, month!, day!) || hour! > 23 || minute! > 59 || second! > 59 || offsetHours > 23 || offsetMinutes > 59) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(year!, month! - 1, day!); // not Date.UTC: it maps years 0-99 to 1900-1999
  date.setUTCHours(hour!, minute!, second!, Number((m[7] ?? "").slice(0, 3).padEnd(3, "0")));
  const offset = (m[8] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  return date.getTime() - offset;
}

/** A `YYYY-MM-DD` day as days since 1970-01-01. */
export const dayNumber = (day: string): number => instantOf(`${day}T00:00:00Z`)! / 86_400_000;

// --- LIKE ----------------------------------------------------------------------------------------------------------

const escapeRegExp = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A LIKE pattern as a regular expression: `%` any run, `_` one code point, `\` makes the next character literal. */
export function likeRegExp(pattern: string): RegExp {
  let source = "";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "\\" && i + 1 < chars.length) source += escapeRegExp(chars[++i]!);
    else if (c === "%") source += "[\\s\\S]*";
    else if (c === "_") source += "[\\s\\S]";
    else source += escapeRegExp(c);
  }
  return new RegExp(`^${source}$`, "u");
}
