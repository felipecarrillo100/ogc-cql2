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
 * point order (not JavaScript's UTF-16 order). `CASEI` applies Unicode's full case folding
 * (`/req/case-insensitive-comparison/casei-function` E) and `ACCENTI` removes the nonspacing marks
 * (`/req/accent-insensitive-comparison/accenti-function` E), each to exactly what it wraps, in the order written.
 * A `LIKE` `_` matches one code point.
 */
import { unwrap, type Fold } from "../core/folds.js";
import type { Cql2Filter, FoldedString, ScalarLiteral } from "../core/types.js";
import { assertValid } from "../validate/index.js";
import { compareCodePoints, dayOf, foldKey, instantOf, likeRegExp } from "./strings.js";

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

// --- Values --------------------------------------------------------------------------------------------------------

type Key = string | number | boolean;

/** A literal compiled once: its key, and how to read a feature value of the same type (`undefined`: a mismatch). */
interface Operand {
  readonly key: Key;
  readonly read: (value: unknown) => Key | undefined;
}

/** `subjectFolds`: what the subject's value goes through (`CASEI`, `ACCENTI`), innermost first. */
function operand(literal: ScalarLiteral | FoldedString, subjectFolds: readonly Fold[]): Operand {
  const readString = (v: unknown): Key | undefined => (typeof v === "string" ? foldKey(v, subjectFolds) : undefined);
  if (typeof literal === "string") return { key: foldKey(literal, []), read: readString };
  if (typeof literal === "number") return { key: literal, read: (v) => (typeof v === "number" ? v : undefined) };
  if (typeof literal === "boolean") return { key: literal, read: (v) => (typeof v === "boolean" ? v : undefined) };
  if ("op" in literal) {
    const { inner, folds } = unwrap(literal);
    return { key: foldKey(inner, folds), read: readString };
  }
  if ("date" in literal) return { key: literal.date, read: dayOf };
  return { key: instantOf(literal.timestamp)!, read: instantOf }; // validate has checked it is an instant
}

const isNullish = (v: unknown): v is null | undefined => v === null || v === undefined;

const order = (a: Key, b: Key): number =>
  typeof a === "string" && typeof b === "string" ? compareCodePoints(a, b) : a === b ? 0 : a < b ? -1 : 1;

const COMPARE: Record<string, (o: number) => boolean> = {
  "=": (o) => o === 0,
  "<>": (o) => o !== 0,
  "<": (o) => o < 0,
  "<=": (o) => o <= 0,
  ">": (o) => o > 0,
  ">=": (o) => o >= 0,
};

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
      const { inner, folds } = unwrap(subject);
      // CASEI and ACCENTI fold what they wrap; `%`, `_` and `\` fold to themselves, so the pattern's meaning survives.
      const p = unwrap(pattern);
      const re = likeRegExp(foldKey(p.inner, p.folds));
      return (f) => {
        const v = get(f, inner.property);
        if (isNullish(v) || typeof v !== "string") return null;
        return re.test(foldKey(v, folds));
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
      const { inner, folds } = unwrap(subject);
      const name = inner.property;
      const operands = list.map((item) => operand(item, folds));
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
      const { inner, folds } = unwrap(subject);
      const name = inner.property;
      const o = operand(value, folds);
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
