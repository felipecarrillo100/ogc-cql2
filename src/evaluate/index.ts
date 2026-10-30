/**
 * `ogc-cql2/evaluate`: tests features against a CQL2-JSON filter, in memory.
 *
 * Evaluated with the three-valued logic of CQL2 1.0.0 (OGC 21-065r2), so a filter selects the same features here as
 * on a server:
 * - a comparison, `LIKE`, `BETWEEN` or `IN` on a null or missing value is NULL, "unknown" ("If either … is NULL then
 *   the predicate SHALL evaluate to the value NULL": `/req/basic-cql2/binary-comparison-predicate` C,
 *   `/req/advanced-comparison-operators/like-predicate` C, `…/between-predicate` C);
 * - `IS NULL` is never NULL;
 * - AND / OR follow the standard's Table 2, and NOT its Table 3 (Kleene logic: FALSE wins in AND, TRUE wins in OR,
 *   NOT NULL is NULL);
 * - a feature is selected only when the result is TRUE.
 *
 * What the standard leaves to the implementation is decided here, and also gives NULL:
 * - **A value of another type than the literal** (a number property compared with a string, a non-number in
 *   `BETWEEN`): both sides "SHALL evaluate to the same type" (`binary-comparison-predicate` D), and type casts are
 *   system-dependent (`/per/basic-cql2/type-casts`). Values are never converted.
 * - **Dates and instants:** a `{date}` matches a `"YYYY-MM-DD"` string or a `Date` (its UTC day); a `{timestamp}`
 *   matches an ISO 8601 string with `Z` or an offset, or a `Date`, at millisecond precision. A time without an offset
 *   is ambiguous, so it is NULL too.
 *
 * Strings are compared after Unicode normalization (NFC; Recommendation 1, `/rec/core/string-normalization`), in code
 * point order. `CASEI` applies Unicode's full case folding (`/req/case-insensitive-comparison/casei-function` E) to
 * exactly what it wraps. A `LIKE` `_` matches one code point.
 */
import type { CaseiProperty, CaseiString, Cql2Filter, PropertyRef, ScalarLiteral } from "../core/types.js";
import { assertValid } from "../validate/index.js";
import { CASE_FOLDING } from "./caseFolding.js";

/** TRUE, FALSE, or NULL (unknown). */
export type Truth = boolean | null;

export interface EvaluateOptions<F = unknown> {
  /**
   * Reads a property of a feature. Default: `feature.properties[name]`, as in GeoJSON. `undefined` counts as null
   * (a missing property).
   */
  readonly getProperty?: (feature: F, name: string) => unknown;
}

const defaultGetProperty = (feature: unknown, name: string): unknown =>
  (feature as { properties?: Record<string, unknown> } | null | undefined)?.properties?.[name];

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

/** A string's comparison key: NFC, or, under CASEI, its canonical caseless form recomposed to NFC. */
const plainKey = (text: string): string => text.normalize("NFC");
const caseiKey = (text: string): string => caseFold(text.normalize("NFD")).normalize("NFC");

// --- Values --------------------------------------------------------------------------------------------------------

type Key = string | number | boolean;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// ISO 8601 date-time with Z or an offset; seconds and their fraction optional.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

function dayOf(value: unknown): string | undefined {
  if (typeof value === "string") return DAY.test(value) ? value : undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return undefined;
}

function instantOf(value: unknown): number | undefined {
  if (typeof value === "string") return INSTANT.test(value) ? Date.parse(value) : undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  return undefined;
}

/** A literal compiled once: its key, and how to read a feature value of the same type (`undefined`: a mismatch). */
interface Operand {
  readonly key: Key;
  readonly read: (value: unknown) => Key | undefined;
}

function operand(literal: ScalarLiteral | CaseiString, caseiSubject: boolean): Operand {
  const readString = (v: unknown): Key | undefined =>
    typeof v === "string" ? (caseiSubject ? caseiKey(v) : plainKey(v)) : undefined;
  if (typeof literal === "string") return { key: plainKey(literal), read: readString };
  if (typeof literal === "number") return { key: literal, read: (v) => (typeof v === "number" ? v : undefined) };
  if (typeof literal === "boolean") return { key: literal, read: (v) => (typeof v === "boolean" ? v : undefined) };
  if ("op" in literal) return { key: caseiKey(literal.args[0]), read: readString };
  if ("date" in literal) return { key: literal.date, read: dayOf };
  return { key: Date.parse(literal.timestamp), read: instantOf };
}

const isNullish = (v: unknown): v is null | undefined => v === null || v === undefined;

const order = (a: Key, b: Key): number => (a === b ? 0 : a < b ? -1 : 1);

const COMPARE: Record<string, (o: number) => boolean> = {
  "=": (o) => o === 0,
  "<>": (o) => o !== 0,
  "<": (o) => o < 0,
  "<=": (o) => o <= 0,
  ">": (o) => o > 0,
  ">=": (o) => o >= 0,
};

// --- LIKE ----------------------------------------------------------------------------------------------------------

const escapeRegExp = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A LIKE pattern as a regular expression: `%` any run, `_` one code point, `\` makes the next character literal. */
function likeRegExp(pattern: string): RegExp {
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

// --- Logic ---------------------------------------------------------------------------------------------------------

// Table 2 of the standard.
function and(a: Truth, b: Truth): Truth {
  if (a === false || b === false) return false;
  return a === true && b === true ? true : null;
}
function or(a: Truth, b: Truth): Truth {
  if (a === true || b === true) return true;
  return a === false && b === false ? false : null;
}
// Table 3.
const not = (a: Truth): Truth => (a === null ? null : !a);

type Getter<F> = (feature: F, name: string) => unknown;

const nameOf = (x: PropertyRef | CaseiProperty): string => ("property" in x ? x.property : x.args[0].property);
const isCasei = (x: PropertyRef | CaseiProperty): boolean => !("property" in x);

function compile<F>(filter: Cql2Filter, get: Getter<F>): (feature: F) => Truth {
  if (typeof filter === "boolean") return () => filter;
  switch (filter.op) {
    case "and": {
      const parts = filter.args.map((arg) => compile(arg, get));
      return (f) => parts.reduce<Truth>((acc, part) => and(acc, part(f)), true);
    }
    case "or": {
      const parts = filter.args.map((arg) => compile(arg, get));
      return (f) => parts.reduce<Truth>((acc, part) => or(acc, part(f)), false);
    }
    case "not": {
      const inner = compile(filter.args[0], get);
      return (f) => not(inner(f));
    }
    case "isNull": {
      const name = filter.args[0].property;
      return (f) => isNullish(get(f, name));
    }
    case "like": {
      const [subject, pattern] = filter.args;
      const name = nameOf(subject);
      const casei = isCasei(subject);
      // CASEI folds what it wraps; `%`, `_` and `\` fold to themselves, so the pattern's meaning survives.
      const re = likeRegExp(typeof pattern === "string" ? plainKey(pattern) : caseiKey(pattern.args[0]));
      return (f) => {
        const v = get(f, name);
        if (isNullish(v) || typeof v !== "string") return null;
        return re.test(casei ? caseiKey(v) : plainKey(v));
      };
    }
    case "between": {
      const [subject, low, high] = filter.args;
      return (f) => {
        const v = get(f, subject.property);
        if (isNullish(v) || typeof v !== "number") return null;
        return v >= low && v <= high;
      };
    }
    case "in": {
      const [subject, list] = filter.args;
      const name = nameOf(subject);
      const operands = list.map((item) => operand(item, isCasei(subject)));
      return (f) => {
        const v = get(f, name);
        if (isNullish(v)) return null;
        let mismatch = false;
        for (const o of operands) {
          const key = o.read(v);
          if (key === undefined) mismatch = true;
          else if (key === o.key) return true;
        }
        return mismatch ? null : false;
      };
    }
    default: {
      const [subject, value] = filter.args;
      const name = nameOf(subject);
      const o = operand(value, isCasei(subject));
      const test = COMPARE[filter.op]!;
      return (f) => {
        const v = get(f, name);
        if (isNullish(v)) return null;
        const key = o.read(v);
        return key === undefined ? null : test(order(key, o.key));
      };
    }
  }
}

/**
 * The filter compiled once, to the three-valued result for each feature: `true`, `false` or `null` (unknown).
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 */
export function toEvaluator<F = unknown>(filter: Cql2Filter, options: EvaluateOptions<F> = {}): (feature: F) => Truth {
  return compile(assertValid(filter), options.getProperty ?? (defaultGetProperty as Getter<F>));
}

/**
 * The filter compiled once, to a predicate: `true` for a feature the filter selects (TRUE), `false` for FALSE and
 * NULL alike.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 */
export function toPredicate<F = unknown>(filter: Cql2Filter, options: EvaluateOptions<F> = {}): (feature: F) => boolean {
  const evaluator = toEvaluator(filter, options);
  return (feature) => evaluator(feature) === true;
}

/**
 * One feature against a filter: `true`, `false` or `null` (unknown). For many features, compile once with
 * {@link toPredicate} or {@link toEvaluator}.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 */
export function evaluate<F = unknown>(filter: Cql2Filter, feature: F, options: EvaluateOptions<F> = {}): Truth {
  return toEvaluator(filter, options)(feature);
}
