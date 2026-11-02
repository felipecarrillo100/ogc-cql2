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
import { CONVERSE, dimension, literalGeometry, relates, transpose, type MatrixRelation } from "../core/relate.js";
import { isArithmetic, operate } from "../core/arithmetic.js";
import { heldKind } from "../core/queryables.js";
import { OPEN, holds, isTemporal, type End } from "../core/temporal.js";
import type {
  ArithmeticOperand, Cql2Filter, FoldedString, Geometry, IntervalEnd, NumericOperand, Operand,
  PropertyRef, Queryable, ScalarLiteral, SpatialLiteral, SpatialOperator, TemporalOperand, TemporalOperator,
} from "../core/types.js";
import { CONFORMANCE } from "../core/conformance.js";
import { implementedBut, refuseUnsupported } from "../core/unsupported.js";
import { geometryParts, intersects, literalParts } from "./spatial.js";
import { assertValid, requiredConformance } from "../validate/index.js";
import { compareCodePoints, dayNumber, dayOf, foldKey, instantOf, likeRegExp } from "./strings.js";

/** TRUE, FALSE, or NULL (unknown). */
export type Truth = boolean | null;

export interface EvaluateOptions<F = unknown> {
  /**
   * Reads a property of a feature. Default: `feature.properties[name]`, as in GeoJSON. `undefined` counts as null
   * (a missing property).
   */
  readonly getProperty?: (feature: F, name: string) => unknown;
  /**
   * The property that names a feature's geometry in spatial filters, read as `feature.geometry` (where GeoJSON keeps
   * it) rather than through `getProperty`. Default `"geometry"`; any other property in a spatial filter is read with
   * `getProperty`, and must hold a GeoJSON geometry.
   */
  readonly geometryProperty?: string;
  /**
   * A geometry engine for the Spatial Functions class (S_DISJOINT, S_EQUALS, S_TOUCHES, S_WITHIN, S_OVERLAPS,
   * S_CROSSES, S_CONTAINS); without one the class is refused (`unsupported`), S_DISJOINT included, and
   * {@link evaluateConformance} leaves it out. S_INTERSECTS (Basic Spatial Functions) needs none. With one, S_INTERSECTS
   * and S_DISJOINT still use the package's own exact engine. See {@link SpatialEngine}.
   */
  readonly spatialEngine?: SpatialEngine;
  /**
   * The properties' queryables, as `validate` takes them (a collection's queryables). They are used only where two
   * properties are compared with each other (Property-Property Comparisons), where no literal says what kind of value
   * to compare: a property with `format: "date"` is then read as a day, one with `"date-time"` as an instant, as
   * against a date or a timestamp literal. Without them, two properties compare by their values' types: strings as
   * strings (exact for `YYYY-MM-DD` dates, and for UTC instants written alike), numbers, booleans, and `Date`s as
   * instants. A SQL dialect selects what `evaluate` selects given the same queryables.
   */
  readonly queryables?: Readonly<Record<string, Queryable | object>>;
}

/**
 * A planar geometry engine (GEOS in WebAssembly, for one), plugged into `evaluate` for the Spatial Functions class. It
 * only computes DE-9IM matrices: what each CQL2 function means (its patterns, the dimension rules of S_OVERLAPS and
 * S_CROSSES) is decided by the package. Geometries are GeoJSON, heights included; a box literal comes as a Polygon,
 * across the antimeridian as a MultiPolygon. NULLs, values that aren't a geometry and empty geometries never reach the
 * engine; an engine that throws for a feature (an invalid polygon) gives NULL for it.
 */
export interface SpatialEngine {
  /** Called once per spatial literal, when the filter is compiled. */
  prepare(literal: Geometry): {
    /** The DE-9IM matrix of (literal, geometry), the literal first: nine characters of `F`, `0`, `1`, `2`. */
    relate(geometry: Geometry): string;
  };
}

const defaultGetProperty = (feature: unknown, name: string): unknown =>
  (feature as { properties?: Record<string, unknown> } | null | undefined)?.properties?.[name];

// --- Values --------------------------------------------------------------------------------------------------------

type Key = string | number | boolean;

const isNullish = (v: unknown): v is null | undefined => v === null || v === undefined;

/**
 * The order of two keys of one kind. NaN (a number only `getProperty` can give: JSON has none) is equal to itself and
 * greater than every other number, from either side, as PostgreSQL and DuckDB order it; CQL2 defines no NaN.
 */
function order(a: Key, b: Key): number {
  if (typeof a === "string" && typeof b === "string") return compareCodePoints(a, b);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : -1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const COMPARE: Record<string, (o: number) => boolean> = {
  "=": (o) => o === 0,
  "<>": (o) => o !== 0,
  "<": (o) => o < 0,
  "<=": (o) => o <= 0,
  ">": (o) => o > 0,
  ">=": (o) => o >= 0,
};

/** What the two sides of a comparison are compared as. */
type ReadKind = "string" | "number" | "boolean" | "date" | "instant";

/** A side of a comparison, compiled once: a literal's key, or a property to read from each feature. */
type Side =
  | { readonly key: Key; readonly kind: ReadKind }
  | { readonly name: string; readonly folds: readonly Fold[]; readonly held: ReadKind | undefined }
  | { readonly arithmetic: (feature: unknown) => number | null; readonly folds: readonly Fold[] };

// --- Arithmetic Expressions ---------------------------------------------------------------------------------------

/**
 * An arithmetic expression, compiled once: NULL when an operand is NULL or not a number (values are never
 * converted), or when the result isn't a finite number (division by zero, overflow, `0 ^ −1`, `(−8) ^ 0.5`).
 * `constant`: no property in it, so the result is the same for every feature.
 */
function compileArithmetic(x: NumericOperand, get: Getter<unknown>): { readonly value: (f: unknown) => number | null; readonly constant: boolean } {
  if (typeof x === "number") return { value: () => x, constant: true };
  if (!isArithmetic(x)) {
    const name = (x as PropertyRef).property;
    return { value: (f) => { const v = get(f, name); return typeof v === "number" ? v : null; }, constant: false };
  }
  const [a, b] = [compileArithmetic(x.args[0], get), compileArithmetic(x.args[1], get)];
  return { value: (f) => operate(x.op, a.value(f), b.value(f)), constant: a.constant && b.constant };
}

/** A value read as `kind`, under the side's folds; `undefined` when it isn't one (a type mismatch). */
function read(value: unknown, kind: ReadKind, folds: readonly Fold[]): Key | undefined {
  switch (kind) {
    case "string":
      return typeof value === "string" ? foldKey(value, folds) : undefined;
    case "number":
      return typeof value === "number" ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "date":
      return dayOf(value);
    case "instant":
      return instantOf(value);
  }
}

/** What a value is, when no literal and no queryable says: its own type (a `Date` is an instant). */
const kindOf = (value: unknown): ReadKind | undefined =>
  typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean"
    : value instanceof Date ? "instant" : undefined;

/** A literal side: its key. A string is compared after NFC, folded as written. */
function literalSide(x: ScalarLiteral | FoldedString): Side {
  if (typeof x === "string") return { key: foldKey(x, []), kind: "string" };
  if (typeof x === "number") return { key: x, kind: "number" };
  if (typeof x === "boolean") return { key: x, kind: "boolean" };
  if ("op" in x) {
    const { inner, folds } = unwrap(x);
    return { key: foldKey(inner, folds), kind: "string" };
  }
  if ("date" in x) return { key: x.date, kind: "date" };
  return { key: instantOf(x.timestamp)!, kind: "instant" }; // validate has checked it is an instant
}

type Queryables = EvaluateOptions["queryables"];

/** A side: a literal, or a property (or CASEI / ACCENTI of one) with what its queryable says it holds. */
function sideOf(x: ArithmeticOperand, queryables: Queryables, get: Getter<unknown>): Side {
  if (isArithmetic(x)) {
    const { value, constant } = compileArithmetic(x, get);
    if (!constant) return { arithmetic: value, folds: [] };
    const result = value(undefined); // no property in it: computed once
    return result === null ? { arithmetic: () => null, folds: [] } : { key: result, kind: "number" };
  }
  if (typeof x !== "object" || !("property" in x || ("op" in x && !isFoldedString(x)))) return literalSide(x as unknown as ScalarLiteral | FoldedString);
  const { inner, folds } = unwrap(x as Exclude<Operand, ScalarLiteral | FoldedString>);
  const q = queryables && Object.hasOwn(queryables, inner.property) ? heldKind(queryables[inner.property] as Queryable) : undefined;
  return { name: inner.property, folds, held: q === "date" ? "date" : q === "instant" ? "instant" : undefined };
}

/** `CASEI('x')` / `ACCENTI('x')`, a string under folds (not a property under them). */
const isFoldedString = (x: object): boolean => typeof unwrap(x as FoldedString).inner === "string";

/**
 * Compares two sides: NULL when either is null or missing, or when they aren't of one kind (a type mismatch). The
 * kind is the literal's; for two properties, a string under CASEI / ACCENTI, else what their queryables say, else
 * the values' own types.
 */
function comparer<F>(a: Side, b: Side, test: (order: number) => boolean, get: Getter<F>): (feature: F) => Truth {
  // CASEI and ACCENTI give strings, so two properties under them compare as strings.
  const folded = ("folds" in a && a.folds.length > 0) || ("folds" in b && b.folds.length > 0);
  const fixed = "kind" in a ? a.kind : "kind" in b ? b.kind : "arithmetic" in a || "arithmetic" in b ? "number"
    : folded ? "string" : "held" in a && a.held ? a.held : "held" in b ? b.held : undefined;
  const conflict = "held" in a && "held" in b && a.held !== undefined && b.held !== undefined && a.held !== b.held;
  const keyOf = (side: Side, kind: ReadKind | undefined, value: unknown): Key | null | undefined => {
    if ("key" in side) return side.key;
    if (isNullish(value)) return null;
    return read(value, kind ?? kindOf(value) ?? "string", side.folds);
  };
  if ("key" in a && "key" in b) {
    const result = test(order(a.key, b.key)); // two literals: decided once
    return () => result;
  }
  const valueOf = (side: Side, f: F): unknown =>
    "name" in side ? get(f, side.name) : "arithmetic" in side ? side.arithmetic(f) : undefined;
  return (f) => {
    const va = valueOf(a, f);
    const vb = valueOf(b, f);
    if (("key" in a ? false : isNullish(va)) || ("key" in b ? false : isNullish(vb))) return null;
    if (conflict) return null;
    // Two properties without a queryable: both values must be of one kind.
    const kind = fixed ?? kindOf(va);
    if (fixed === undefined && (kind === undefined || kindOf(vb) !== kind)) return null;
    const ka = keyOf(a, kind, va);
    const kb = keyOf(b, kind, vb);
    return ka === undefined || kb === undefined || ka === null || kb === null ? null : test(order(ka, kb));
  };
}

// --- Temporal Functions --------------------------------------------------------------------------------------------

type TemporalKind = "date" | "instant";

/** An end, compiled once: a value (a literal's, or ±Infinity for ".."), or a property to read from each feature. */
type TemporalEnd = { readonly value: number; readonly kind: TemporalKind | undefined } | { readonly name: string };

const endOf = (x: IntervalEnd, open: number): TemporalEnd =>
  typeof x !== "string" ? { name: x.property }
    : x === OPEN ? { value: open, kind: undefined }
    : x.includes("T") ? { value: instantOf(x)!, kind: "instant" } // validate has checked both
    : { value: dayNumber(x), kind: "date" };

/** An operand's begin and end: an instant is the interval from it to itself. */
function endsOf(x: TemporalOperand): readonly [TemporalEnd, TemporalEnd] {
  if ("interval" in x) return [endOf(x.interval[0], -Infinity), endOf(x.interval[1], Infinity)];
  if ("property" in x) return [{ name: x.property }, { name: x.property }];
  const end: TemporalEnd = "date" in x ? { value: dayNumber(x.date), kind: "date" } : { value: instantOf(x.timestamp)!, kind: "instant" };
  return [end, end];
}

/** A value as an end of `kind`, or of its own kind when nothing says (a `Date` is an instant); `undefined` if it isn't one. */
function moment(value: unknown, kind: TemporalKind | undefined): { readonly value: number; readonly kind: TemporalKind } | undefined {
  const k = kind ?? (value instanceof Date || dayOf(value) === undefined ? "instant" : "date");
  const day = k === "date" ? dayOf(value) : undefined;
  const ms = k === "instant" ? instantOf(value) : undefined;
  return day !== undefined ? { value: dayNumber(day), kind: k } : ms !== undefined ? { value: ms, kind: k } : undefined;
}

const INDEX: Readonly<Record<End, number>> = { b1: 0, e1: 1, b2: 2, e2: 3 };

/**
 * A temporal function, compiled once. All the ends are of one kind: a literal's, else what the properties'
 * queryables say, else the values' own (each must be of the same). NULL when a property is NULL or not of the kind,
 * or when an interval begins after it ends (it is no interval).
 */
function temporal<F>(op: TemporalOperator, args: readonly [TemporalOperand, TemporalOperand], get: Getter<F>, queryables: Queryables): (feature: F) => Truth {
  const ends = [...endsOf(args[0]), ...endsOf(args[1])];
  const held = (name: string): TemporalKind | undefined => {
    const q = queryables && Object.hasOwn(queryables, name) ? heldKind(queryables[name] as Queryable) : undefined;
    return q === "date" ? "date" : q === "instant" ? "instant" : undefined;
  };
  const literals = new Set(ends.flatMap((e) => ("kind" in e && e.kind ? [e.kind] : [])));
  const kinds = literals.size > 0 ? literals : new Set(ends.flatMap((e) => ("name" in e && held(e.name) ? [held(e.name)!] : [])));
  if (kinds.size > 1) return () => null; // queryables of both kinds: never one kind
  const kind = kinds.values().next().value;
  const decide = (v: readonly number[]): Truth =>
    order(v[0]!, v[1]!) > 0 || order(v[2]!, v[3]!) > 0 ? null : holds(op, ([l, o, r]) => COMPARE[o]!(order(v[INDEX[l]]!, v[INDEX[r]]!)));
  if (ends.every((e) => "value" in e)) {
    const result = decide(ends.map((e) => (e as { value: number }).value)); // literals only: decided once
    return () => result;
  }
  return (f) => {
    const values: number[] = [];
    let seen = kind;
    for (const e of ends) {
      if ("value" in e) {
        values.push(e.value);
        continue;
      }
      const v = get(f, e.name);
      if (isNullish(v)) return null;
      const m = moment(v, kind);
      if (m === undefined || (seen !== undefined && m.kind !== seen)) return null; // not of the kind: a type mismatch
      seen = m.kind;
      values.push(m.value);
    }
    return decide(values);
  };
}

// --- Spatial relations with a literal first, or two properties (Property-Property Comparisons) ---------------------

const isRef = (x: PropertyRef | SpatialLiteral): x is PropertyRef => "property" in x;

/** Whether the relation holds between two geometries; NULL when the engine can't compute it. */
function relation(op: SpatialOperator, a: Geometry, b: Geometry, engine: SpatialEngine | undefined): Truth {
  const [pa, pb] = [geometryParts(a)!, geometryParts(b)!];
  if (op === "s_intersects" || op === "s_disjoint") return intersects(pa, pb) !== (op === "s_disjoint");
  // An empty geometry shares no point with anything: no relation but S_DISJOINT holds.
  if (pa.box === undefined || pb.box === undefined) return relates(op, "FFFFFFFF2", -1, -1);
  try {
    return relates(op, engine!.prepare(a).relate(b), dimension(a), dimension(b));
  } catch {
    return null; // the engine can't compute it (an invalid polygon): unknown
  }
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


function compile<F>(
  filter: Cql2Filter, get: Getter<F>, geometry: string, engine: SpatialEngine | undefined, queryables: Queryables,
): (feature: F) => Truth {
  if (typeof filter === "boolean") return () => filter;
  const sub = (x: Cql2Filter) => compile(x, get, geometry, engine, queryables);
  if (isTemporal(filter.op)) return temporal(filter.op, filter.args as readonly [TemporalOperand, TemporalOperand], get, queryables);
  if (filter.op in CONVERSE) {
    const op = filter.op as SpatialOperator;
    const [a, b] = filter.args as readonly [PropertyRef | SpatialLiteral, PropertyRef | SpatialLiteral];
    if (!isRef(a) && isRef(b)) return sub({ op: CONVERSE[op], args: [b, a] }); // a literal first: the converse
    if (!isRef(a) && !isRef(b)) {
      const result = relation(op, literalGeometry(a), literalGeometry(b), engine); // two literals: decided once
      return () => result;
    }
    if (isRef(a) && isRef(b)) {
      const read = (ref: PropertyRef) =>
        ref.property === geometry ? (f: F) => (f as { geometry?: unknown } | null)?.geometry : (f: F) => get(f, ref.property);
      const [ra, rb] = [read(a), read(b)];
      return (f) => {
        const [va, vb] = [ra(f), rb(f)];
        if (isNullish(va) || isNullish(vb)) return null;
        // A value that isn't a geometry: a type mismatch, NULL.
        if (geometryParts(va) === undefined || geometryParts(vb) === undefined) return null;
        return relation(op, va as Geometry, vb as Geometry, engine);
      };
    }
  }
  switch (filter.op) {
    case "and": {
      const parts = filter.args.map(sub);
      return (f) => parts.reduce<Truth>((acc, part) => and(acc, part(f)), true);
    }
    case "or": {
      const parts = filter.args.map(sub);
      return (f) => parts.reduce<Truth>((acc, part) => or(acc, part(f)), false);
    }
    case "not": {
      const inner = sub(filter.args[0]);
      return (f) => not(inner(f));
    }
    case "isNull": {
      const name = filter.args[0].property;
      return (f) => isNullish(get(f, name));
    }
    case "like": {
      const [left, pattern] = filter.args;
      // CASEI and ACCENTI fold what they wrap; `%`, `_` and `\` fold to themselves, so the pattern's meaning survives.
      const p = unwrap(pattern);
      const re = likeRegExp(foldKey(p.inner, p.folds));
      const side = sideOf(left, queryables, get as Getter<unknown>);
      if (!("name" in side)) {
        if (!("key" in side)) return () => null; // not reached: validate allows no arithmetic in LIKE
        const result = re.test(side.key as string); // a string literal on the left: decided once
        return () => result;
      }
      return (f) => {
        const v = get(f, side.name);
        if (isNullish(v) || typeof v !== "string") return null;
        return re.test(foldKey(v, side.folds));
      };
    }
    case "between": {
      // x BETWEEN low AND high is x >= low AND x <= high (the standard's BETWEEN is inclusive), in three-valued logic.
      const [x, low, high] = filter.args.map((arg) => sideOf(arg, queryables, get as Getter<unknown>)) as [Side, Side, Side];
      const atLeast = comparer(x, low, COMPARE[">="]!, get);
      const atMost = comparer(x, high, COMPARE["<="]!, get);
      return (f) => and(atLeast(f), atMost(f));
    }
    case "s_intersects":
    case "s_disjoint": {
      // S_DISJOINT is NOT S_INTERSECTS: the same NULLs.
      const [subject, literal] = filter.args as readonly [PropertyRef, SpatialLiteral]; // the shapes above are handled
      const target = literalParts(literal);
      const geometryOf = subject.property === geometry ? (f: F) => (f as { geometry?: unknown } | null)?.geometry : (f: F) => get(f, subject.property);
      const disjoint = filter.op === "s_disjoint";
      return (f) => {
        const value = geometryOf(f);
        if (isNullish(value)) return null;
        const parts = geometryParts(value);
        return parts === undefined ? null : intersects(parts, target) !== disjoint; // not a geometry: a type mismatch, NULL
      };
    }
    case "s_equals":
    case "s_touches":
    case "s_within":
    case "s_overlaps":
    case "s_crosses":
    case "s_contains": {
      const [subject, literal] = filter.args as readonly [PropertyRef, SpatialLiteral]; // the shapes above are handled
      const relation: MatrixRelation = filter.op;
      const target = literalGeometry(literal);
      const prepared = engine!.prepare(target); // refused before compiling without an engine
      const dimLiteral = dimension(target);
      const geometryOf = subject.property === geometry ? (f: F) => (f as { geometry?: unknown } | null)?.geometry : (f: F) => get(f, subject.property);
      return (f) => {
        const value = geometryOf(f);
        if (isNullish(value)) return null;
        const parts = geometryParts(value);
        if (parts === undefined) return null; // not a geometry: a type mismatch, NULL
        const g = value as Geometry;
        // An empty geometry shares no point with anything: only the exteriors meet.
        if (parts.box === undefined) return relates(relation, "FFFFFFFF2", -1, dimLiteral);
        let matrix: string;
        try {
          matrix = prepared.relate(g);
        } catch {
          return null; // the engine can't compute it (an invalid polygon): unknown
        }
        return relates(relation, transpose(matrix), dimension(g), dimLiteral);
      };
    }
    case "in": {
      // x IN (a, b, …) is x = a OR x = b OR …, in three-valued logic.
      const [left, list] = filter.args;
      const x = sideOf(left, queryables, get as Getter<unknown>);
      const equals = list.map((item) => comparer(x, sideOf(item, queryables, get as Getter<unknown>), COMPARE["="]!, get));
      return (f) => equals.reduce<Truth>((acc, eq) => (acc === true ? true : or(acc, eq(f))), false);
    }
    default: {
      const [a, b] = filter.args as readonly [ArithmeticOperand, ArithmeticOperand];
      return comparer(sideOf(a, queryables, get as Getter<unknown>), sideOf(b, queryables, get as Getter<unknown>), COMPARE[filter.op]!, get);
    }
  }
}

/**
 * The conformance classes `evaluate`, `toEvaluator` and `toPredicate` evaluate with these options, as URIs (as in
 * `CONFORMANCE`): every class the package implements, but Spatial Functions without a `spatialEngine`. Pass it to
 * `validate` (`{ conformance }`) to refuse up front, as `needs-conformance`, what these options would refuse as
 * `unsupported`; a filter valid against it never is. A new array, in `CONFORMANCE`'s order, to change at will.
 */
export function evaluateConformance<F = unknown>(options: EvaluateOptions<F> = {}): string[] {
  return implementedBut(options.spatialEngine ? [] : [CONFORMANCE.spatial]);
}

/**
 * The filter compiled once, to the three-valued result for each feature: `true`, `false` or `null` (unknown).
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 * @throws Cql2Error `unsupported` for a filter of a class not in {@link evaluateConformance}: Spatial Functions
 * (S_DISJOINT, S_EQUALS, S_TOUCHES, …) without `options.spatialEngine`.
 */
export function toEvaluator<F = unknown>(filter: Cql2Filter, options: EvaluateOptions<F> = {}): (feature: F) => Truth {
  const valid = assertValid(filter);
  refuseUnsupported(requiredConformance(valid), evaluateConformance(options), `ogc-cql2/evaluate${options.spatialEngine ? "" : " without options.spatialEngine"}`);
  return compile(
    valid, options.getProperty ?? (defaultGetProperty as Getter<F>), options.geometryProperty ?? "geometry", options.spatialEngine,
    options.queryables,
  );
}

/**
 * The filter compiled once, to a predicate: `true` for a feature the filter selects (TRUE), `false` for FALSE and
 * NULL alike.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 * @throws Cql2Error `unsupported` for a filter of a class not in {@link evaluateConformance}: Spatial Functions
 * (S_DISJOINT, S_EQUALS, S_TOUCHES, …) without `options.spatialEngine`.
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
 * @throws Cql2Error `unsupported` for a filter of a class not in {@link evaluateConformance}: Spatial Functions
 * (S_DISJOINT, S_EQUALS, S_TOUCHES, …) without `options.spatialEngine`.
 */
export function evaluate<F = unknown>(filter: Cql2Filter, feature: F, options: EvaluateOptions<F> = {}): Truth {
  return toEvaluator(filter, options)(feature);
}
