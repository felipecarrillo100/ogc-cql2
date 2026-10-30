/**
 * How a value is read for comparison: shared by `evaluate` and by the SQL functions of `ogc-cql2/sql`, so both
 * decide every comparison with the same code. Internal to the package.
 */
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// ISO 8601 date-time with Z or an offset; seconds and their fraction optional.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** A value as a calendar day (`YYYY-MM-DD`): a string of that form, or a `Date`'s UTC day; otherwise `undefined`. */
export function dayOf(value: unknown): string | undefined {
  if (typeof value === "string") return DAY.test(value) ? value : undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return undefined;
}

/** A value as an instant (epoch milliseconds): an ISO 8601 string with Z or an offset, or a `Date`; else `undefined`. */
export function instantOf(value: unknown): number | undefined {
  if (typeof value === "string") return INSTANT.test(value) ? Date.parse(value) : undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return undefined;
}

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
