/**
 * `ogc-cql2/text`: CQL2-JSON → CQL2-text, for the `filter` parameter of OGC API Features Part 3
 * (`filter-lang=cql2-text`).
 *
 * It follows the text encoding's released grammar exactly: `cql2.bnf` at tag `cql2-1.0.0` of
 * github.com/opengeospatial/ogcapi-features. The rule names in the comments are that file's. What the grammar can't
 * express is never written loosely: {@link textProblem} names it, and {@link toText} refuses it.
 */
import { Cql2Error } from "../core/errors.js";
import { unwrap, type Fold } from "../core/folds.js";
import type { Cql2Filter, FoldedString, Geometry, PropertyRef, ScalarLiteral, SpatialLiteral, StringSubject } from "../core/types.js";
import { assertValid } from "../validate/index.js";
import { positionsOf, wkt, wktNumber as number } from "../core/wkt.js";

// `identifierStart` (cql2.bnf, cql2-1.0.0), range by range, in the grammar's order.
const IDENTIFIER_START =
  ":_A-Za-z" +
  "\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}" + // Latin-1 Supplement letters, Latin Extended
  "\\u{370}-\\u{37D}\\u{37F}-\\u{1FFE}" + // Greek and Coptic (without ";"), notes 1
  "\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}" + // zero-width (non-)joiner, notes 2 and 3
  "\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}"; // notes 4 to 7
// `identifierPart` (cql2.bnf, cql2-1.0.0): a start character, ".", a digit, a combining mark, or ‿ / ⁀.
const IDENTIFIER_PART = `${IDENTIFIER_START}.0-9\\u{300}-\\u{36F}\\u{203F}-\\u{2040}`;
const IDENTIFIER = new RegExp(`^[${IDENTIFIER_START}][${IDENTIFIER_PART}]*$`, "u");

// The standard's keywords (OGC 21-065r2, the list ahead of Requirement 20), and INTERVAL, the temporal function. A
// property with such a name is written in double quotes, which the BNF allows only for an identifier:
// `propertyName = identifier | "\"" identifier "\""`.
const KEYWORDS = new Set([
  "A_CONTAINEDBY", "A_CONTAINS", "A_EQUALS", "A_OVERLAPS", "ACCENTI", "AND", "BBOX", "BETWEEN", "CASEI", "DATE", "DIV",
  "FALSE", "GEOMETRYCOLLECTION", "IN", "INTERVAL", "IS", "LIKE", "LINESTRING", "MULTILINESTRING", "MULTIPOINT",
  "MULTIPOLYGON", "NOT", "NULL", "OR", "POINT", "POLYGON", "S_CONTAINS", "S_CROSSES", "S_DISJOINT", "S_EQUALS",
  "S_INTERSECTS", "S_OVERLAPS", "S_TOUCHES", "S_WITHIN", "T_AFTER", "T_BEFORE", "T_CONTAINS", "T_DISJOINT", "T_DURING",
  "T_EQUALS", "T_FINISHEDBY", "T_FINISHES", "T_INTERSECTS", "T_MEETS", "T_METBY", "T_OVERLAPPEDBY", "T_OVERLAPS",
  "T_STARTEDBY", "T_STARTS", "TIMESTAMP", "TRUE",
]);

/** Whether `name` is an `identifier` of the CQL2 grammar: the only names CQL2-text can reference a property by. */
export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

/**
 * A string as a CQL2-text character literal: in single quotes, with each quote inside doubled
 * (`characterLiteral` in the BNF, OGC 21-065r2).
 *
 * @example quoteString("it's") // "'it''s'"
 */
export function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** What CQL2-text can't express, though the filter is valid CQL2-JSON. */
export type TextProblemCode =
  /** A property name that isn't an `identifier` (a space, a leading digit, a quote…): CQL2-text can't reference it. */
  | "property-name"
  /**
   * A backslash in a string. Requirement 21 (`/req/cql2-text/escaping`) makes it the escape character in every
   * literal and defines no escape for a backslash itself. In a `LIKE` pattern, `\%` and `\_` (the LIKE escapes,
   * `/req/advanced-comparison-operators/like-predicate` K) are written as they are; any other backslash is this.
   */
  | "backslash"
  /**
   * A geometry mixing positions with and without a height: WKT's `Z` (`POINT Z(…)`) covers a whole geometry, so
   * CQL2-text can't write one that mixes them.
   */
  | "mixed-dimensions";

export interface TextProblem {
  readonly problem: TextProblemCode;
  /** Where, as a JSON Pointer. */
  readonly path: string;
}

const LIKE_ESCAPES = /\\[%_]/g;

/** The first thing in a valid filter that CQL2-text can't express, or `undefined`. */
export function textProblem(filter: Cql2Filter): TextProblem | undefined {
  const check = (x: unknown, path: string, inPattern = false): TextProblem | undefined => {
    if (typeof x === "string") {
      const rest = inPattern ? x.replace(LIKE_ESCAPES, "") : x;
      return rest.includes("\\") ? { problem: "backslash", path } : undefined;
    }
    if (Array.isArray(x)) {
      for (const [i, item] of x.entries()) {
        const problem = check(item, `${path}/${i}`, inPattern);
        if (problem) return problem;
      }
      return undefined;
    }
    if (typeof x !== "object" || x === null) return undefined;
    if ("coordinates" in x && "type" in x) {
      const dimensions = new Set(positionsOf(x as Geometry).map((p) => p.length));
      return dimensions.size > 1 ? { problem: "mixed-dimensions", path } : undefined;
    }
    if ("property" in x) {
      return isIdentifier((x as PropertyRef).property) ? undefined : { problem: "property-name", path };
    }
    if ("args" in x) {
      const node = x as { op: string; args: readonly unknown[] };
      for (const [i, arg] of node.args.entries()) {
        const problem = check(arg, `${path}/args/${i}`, inPattern || (node.op === "like" && i === 1));
        if (problem) return problem;
      }
    }
    return undefined;
  };
  return check(filter, "");
}

function propertyName(ref: PropertyRef): string {
  return KEYWORDS.has(ref.property.toUpperCase()) ? `"${ref.property}"` : ref.property;
}

/** `inner` wrapped in the folds, innermost first: accenti, casei → `CASEI(ACCENTI(inner))`. */
const wrapped = (inner: string, folds: readonly Fold[]): string =>
  folds.reduce((text, fold) => `${fold.toUpperCase()}(${text})`, inner);

function subject(x: StringSubject): string {
  const { inner, folds } = unwrap(x);
  return wrapped(propertyName(inner), folds);
}

function literal(x: ScalarLiteral | FoldedString): string {
  if (typeof x === "string") return quoteString(x);
  if (typeof x === "boolean") return x ? "TRUE" : "FALSE";
  if (typeof x === "number") return number(x);
  if ("date" in x) return `DATE(${quoteString(x.date)})`;
  if ("timestamp" in x) return `TIMESTAMP(${quoteString(x.timestamp)})`;
  const { inner, folds } = unwrap(x);
  return wrapped(quoteString(inner), folds);
}

// --- Geometries, as WKT per the grammar (`spatialInstance`) ------------------------------------------------------

/** `scientificNumericLiteral = mantissa "E" exponent`: JavaScript writes 1e+21 and 1.5e-7 with a lowercase e. */
/** A geometry literal, or `BBOX(west, south, east, north)` / `BBOX(west, south, min, east, north, max)`. */
const spatialLiteral = (x: SpatialLiteral): string => ("bbox" in x && !("type" in x) ? `BBOX(${x.bbox.map(number).join(", ")})` : wkt(x as Geometry));

/** Each operand of AND / OR in parentheses, so precedence never depends on the reader. */
function group(parts: readonly string[], op: "AND" | "OR"): string {
  return parts.map((part) => `(${part})`).join(` ${op} `);
}

function write(filter: Cql2Filter): string {
  if (typeof filter === "boolean") return filter ? "TRUE" : "FALSE";
  switch (filter.op) {
    case "and":
    case "or":
      return group(filter.args.map(write), filter.op === "and" ? "AND" : "OR");
    case "not":
      return `NOT (${write(filter.args[0])})`;
    case "isNull":
      return `${propertyName(filter.args[0])} IS NULL`;
    case "like":
      return `${subject(filter.args[0])} LIKE ${literal(filter.args[1])}`;
    case "between":
      return `${subject(filter.args[0])} BETWEEN ${literal(filter.args[1])} AND ${literal(filter.args[2])}`;
    case "in":
      return `${subject(filter.args[0])} IN (${filter.args[1].map(literal).join(", ")})`;
    case "s_intersects":
    case "s_equals":
    case "s_disjoint":
    case "s_touches":
    case "s_within":
    case "s_overlaps":
    case "s_crosses":
    case "s_contains":
      return `${filter.op.toUpperCase()}(${propertyName(filter.args[0])}, ${spatialLiteral(filter.args[1])})`;
    default:
      return `${subject(filter.args[0])} ${filter.op} ${literal(filter.args[1])}`;
  }
}

/**
 * Writes a filter as CQL2-text. `true` is `TRUE`: whether to send a filter that keeps everything is the caller's
 * choice.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile (see `ogc-cql2/validate`).
 * @throws Cql2Error `not-expressible` for what {@link textProblem} reports, with `details.problem`.
 */
export function toText(filter: Cql2Filter): string {
  const valid = assertValid(filter);
  const problem = textProblem(valid);
  if (problem) {
    const why =
      problem.problem === "property-name"
        ? "a property name that isn't a CQL2 identifier"
        : "a backslash, which CQL2-text can't escape";
    throw new Cql2Error("not-expressible", `This filter can't be written in CQL2-text: ${why}.`, problem.path, {
      problem: problem.problem,
    });
  }
  return write(valid);
}
