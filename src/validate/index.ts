/**
 * `ogc-cql2/validate`: checks that a value is a CQL2-JSON filter in the package's profile.
 *
 * Every problem comes with a stable code, a JSON Pointer to where it is, and a message. Valid CQL2 that the profile
 * doesn't cover is reported as `outside-profile`, naming the conformance class it would need, never as invalid.
 *
 * The rules are the standard's (OGC 21-065r2): its JSON Schema (`cql2.json`, tag `cql2-1.0.0`), its requirements,
 * and the permissions that let a server accept only a property on the left and a literal on the right.
 */
import { CONFORMANCE, OTHER_CONFORMANCE } from "../core/conformance.js";
import { Cql2Error } from "../core/errors.js";
import type { Cql2Filter, Queryable } from "../core/types.js";

export type ProblemCode =
  /** Not a filter at all: not an object, no `op`, or an expression that gives no TRUE / FALSE (`casei`, `+`…). */
  | "not-an-expression"
  /** An `op` that isn't one of the standard's. CQL2 reads it as a call to a custom function (class Functions). */
  | "unknown-operator"
  /** Valid CQL2 that the profile doesn't cover; `conformance` names the class it needs, when there is one. */
  | "outside-profile"
  /** The wrong number or kind of arguments for the operator. */
  | "wrong-arguments"
  /**
   * Operands whose types can't match: `CASEI` with a number, `LIKE` with a number, `BETWEEN` with a string; with
   * `options.queryables`, also a literal of another type than the property's (`/per/basic-cql2/type-casts`).
   */
  | "type-mismatch"
  /** With `options.queryables`: a property that isn't one of them. */
  | "unknown-property"
  /** An `IN` list whose literals aren't all of one type (`/req/advanced-comparison-operators/in-predicate` B). */
  | "mixed-list"
  /** An empty `IN` list: CQL2-text's grammar (`inList`) needs at least one item. */
  | "empty-list"
  /** A number that isn't finite (NaN, Infinity): CQL2 has no literal for it. */
  | "invalid-number"
  /** `{ "date": … }` that isn't `YYYY-MM-DD`, or a day that doesn't exist. */
  | "invalid-date"
  /** `{ "timestamp": … }` that isn't `YYYY-MM-DDThh:mm:ss[.fff]Z`, or an instant that doesn't exist. */
  | "invalid-timestamp"
  /** A conformance class of the profile that `options.conformance` leaves out (a server that doesn't declare it). */
  | "needs-conformance";

export interface Problem {
  readonly code: ProblemCode;
  /** Where, as a JSON Pointer: `""` is the whole filter, `/args/0` its first argument. */
  readonly path: string;
  readonly message: string;
  /** The conformance class (URI) needed, for `outside-profile`, `unknown-operator` and `needs-conformance`. */
  readonly conformance?: string;
}

export interface ValidateOptions {
  /**
   * The conformance classes to allow, as URIs, typically what a server declares. A filter that needs one of the
   * profile's classes not listed here gets a `needs-conformance` problem. Default: all of the profile.
   */
  readonly conformance?: readonly string[];
  /**
   * The properties a filter may use and their types, typically a collection's queryables (OGC API Features Part 3):
   * a queryables response's `properties`, as it comes. A property not listed is `unknown-property`; a literal that
   * can't be of the property's type is `type-mismatch`, which CQL2 lets a server answer with an error
   * (`/per/basic-cql2/type-casts`). A queryable without a `type` accepts any literal. Default: no check.
   */
  readonly queryables?: Readonly<Record<string, Queryable | object>>;
}

export type ValidationResult =
  | { readonly valid: true; readonly filter: Cql2Filter }
  | { readonly valid: false; readonly problems: readonly Problem[] };

const COMPARISON = new Set(["=", "<>", "<", "<=", ">", ">="]);
const ARITHMETIC = new Set(["+", "-", "*", "/", "^", "%", "div"]);
const SPATIAL = new Set([
  "s_contains", "s_crosses", "s_disjoint", "s_equals", "s_intersects", "s_overlaps", "s_touches", "s_within",
]);
const TEMPORAL = new Set([
  "t_after", "t_before", "t_contains", "t_disjoint", "t_during", "t_equals", "t_finishedBy", "t_finishes",
  "t_intersects", "t_meets", "t_metBy", "t_overlappedBy", "t_overlaps", "t_startedBy", "t_starts",
]);
const ARRAY = new Set(["a_containedBy", "a_contains", "a_equals", "a_overlaps"]);

// The schema's `dateString` and `timestampString` patterns; the calendar check comes on top.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/** Whether year-month-day exists in the (proleptic) Gregorian calendar. */
function isRealDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const isPropertyRef = (x: unknown): x is { property: unknown } => isObject(x) && "property" in x;
const opOf = (x: unknown): string | undefined => (isObject(x) && typeof x.op === "string" ? x.op : undefined);
const argsOf = (x: Json): unknown[] | undefined => (Array.isArray(x.args) ? x.args : undefined);

/** The type of a literal on the right, for the type checks. */
type LiteralKind = "string" | "number" | "boolean" | "date" | "timestamp" | "folded-string";

/** What a queryable holds, for the type checks; `any` when it doesn't say. */
type HeldKind = "text" | "date" | "instant" | "number" | "boolean" | "other" | "any";

function heldKind(q: Queryable): HeldKind {
  if (typeof q.format === "string" && q.format.startsWith("geometry-")) return "other";
  // JSON Schema allows a list of types: a nullable property is ["string", "null"]. NULL is always possible in CQL2.
  const types: unknown = Array.isArray(q.type) ? q.type.filter((t) => t !== "null") : q.type;
  const type = Array.isArray(types) ? (types.length === 1 ? types[0] : undefined) : types;
  if (type === undefined) return q.format === "date" ? "date" : q.format === "date-time" ? "instant" : "any";
  if (type === "string") return q.format === "date" ? "date" : q.format === "date-time" ? "instant" : "text";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  return "other";
}

/** The literals each kind of property can be compared with. */
const ACCEPTS: Readonly<Record<HeldKind, readonly LiteralKind[]>> = {
  text: ["string", "folded-string"],
  date: ["date"],
  instant: ["timestamp"],
  number: ["number"],
  boolean: ["boolean"],
  other: [],
  any: ["string", "folded-string", "number", "boolean", "date", "timestamp"],
};

/** What to compare a property of this kind with, for the messages. */
const WRITE: Readonly<Record<Exclude<HeldKind, "any">, string>> = {
  text: `is a string: compare it with a string, e.g. "Main"`,
  date: `is a date: compare it with a date literal, e.g. { "date": "2020-07-26" }`,
  instant: `is an instant: compare it with a timestamp literal, e.g. { "timestamp": "2020-07-26T12:00:00Z" }`,
  number: `is a number: compare it with a number, e.g. 5 (not "5")`,
  boolean: `is a boolean: compare it with true or false`,
  other: `can't be compared in the profile; it can only be tested with isNull`,
};

/** A subject that passed the checks: whether it is `casei(…)` / `accenti(…)`, and its property's kind (`any` without queryables). */
interface Subject {
  readonly folded: boolean;
  readonly name: string;
  readonly held: HeldKind;
}

class Checker {
  readonly problems: Problem[] = [];
  readonly #allowed: ReadonlySet<string> | undefined;
  readonly #queryables: ValidateOptions["queryables"];

  constructor(options: ValidateOptions) {
    this.#allowed = options.conformance ? new Set(options.conformance) : undefined;
    this.#queryables = options.queryables;
  }

  report(code: ProblemCode, path: string, message: string, conformance?: string): void {
    this.problems.push(conformance === undefined ? { code, path, message } : { code, path, message, conformance });
  }

  /** Notes that the node at `path` uses one of the profile's classes. */
  uses(conformance: string, path: string, what: string): void {
    if (this.#allowed && !this.#allowed.has(conformance)) {
      this.report("needs-conformance", path, `${what} needs the conformance class ${conformance}.`, conformance);
    }
  }

  filter(x: unknown, path: string): void {
    if (typeof x === "boolean") return this.uses(CONFORMANCE.basic, path, "A filter");
    const op = opOf(x);
    if (op === undefined) {
      const what = isPropertyRef(x) ? "A property reference" : Array.isArray(x) ? "An array" : "This value";
      return this.report(
        "not-an-expression", path,
        `${what} is not a filter: a filter is true, false or an object with "op" and "args".`,
      );
    }
    const args = argsOf(x as Json);
    if (args === undefined) return this.report("wrong-arguments", path, `"${op}" needs "args", an array.`);

    if (op === "and" || op === "or") {
      this.uses(CONFORMANCE.basic, path, op.toUpperCase());
      if (args.length < 2) this.report("wrong-arguments", `${path}/args`, `"${op}" needs two or more filters.`);
      args.forEach((arg, i) => this.filter(arg, `${path}/args/${i}`));
      return;
    }
    if (op === "not") {
      this.uses(CONFORMANCE.basic, path, "NOT");
      if (args.length !== 1) return this.report("wrong-arguments", `${path}/args`, `"not" needs exactly one filter.`);
      return this.filter(args[0], `${path}/args/0`);
    }
    if (COMPARISON.has(op)) return this.comparison(op, args, path);
    if (op === "like") return this.like(args, path);
    if (op === "between") return this.between(args, path);
    if (op === "in") return this.inList(args, path);
    if (op === "isNull") return this.isNull(args, path);

    if (SPATIAL.has(op)) {
      // Basic Spatial Functions has S_INTERSECTS with points and boxes only; any other geometry literal needs the
      // class "with additional Spatial Literals" (`basic-spatial-functions-plus`).
      const otherGeometry = args.some((a) => isObject(a) && typeof a.type === "string" && a.type !== "Point");
      const conformance = op !== "s_intersects" ? OTHER_CONFORMANCE.spatial
        : otherGeometry ? OTHER_CONFORMANCE.basicSpatialPlus : OTHER_CONFORMANCE.basicSpatial;
      return this.report("outside-profile", path, `"${op}" is a spatial function, not in the profile yet.`, conformance);
    }
    if (TEMPORAL.has(op)) {
      return this.report(
        "outside-profile", path, `"${op}" is a temporal function, not in the profile yet.`, OTHER_CONFORMANCE.temporal,
      );
    }
    if (ARRAY.has(op)) {
      return this.report(
        "outside-profile", path, `"${op}" is an array function, not in the profile yet.`, OTHER_CONFORMANCE.arrays,
      );
    }
    if (op === "casei" || op === "accenti" || ARITHMETIC.has(op)) {
      return this.report(
        "not-an-expression", path, `"${op}" gives a value, not TRUE or FALSE: compare it with something.`,
      );
    }
    this.report(
      "unknown-operator", path,
      `"${op}" is not a CQL2 operator. CQL2 would read it as a call to a custom function, which needs the ` +
        "Functions class.",
      OTHER_CONFORMANCE.functions,
    );
  }

  /** The left side: a property, or `casei(property)`; `undefined` if invalid. */
  subject(x: unknown, path: string, allowFolds = true): Subject | undefined {
    if (isPropertyRef(x)) {
      const held = this.property(x, path);
      return held === undefined ? undefined : { folded: false, name: x.property as string, held };
    }
    const op = opOf(x);
    if ((op === "casei" || op === "accenti") && allowFolds) return this.foldedSubject(x as Json, op, path, undefined);
    this.notInProfile(x, path, "The left side");
    return undefined;
  }

  /** The arguments of `casei` / `accenti`, checked and noted as using its class; `undefined` after reporting. */
  foldArgs(x: Json, op: "casei" | "accenti", path: string): unknown[] | undefined {
    const args = argsOf(x);
    if (!args || args.length !== 1) {
      this.report("wrong-arguments", `${path}/args`, `"${op}" needs exactly one argument.`);
      return undefined;
    }
    if (op === "casei") this.uses(CONFORMANCE.caseInsensitive, path, "CASEI");
    else this.uses(CONFORMANCE.accentInsensitive, path, "ACCENTI");
    return args;
  }

  /** `casei(…)` / `accenti(…)` on the left: of a property, or of the other function of a property (once). */
  foldedSubject(x: Json, op: "casei" | "accenti", path: string, outer: "casei" | "accenti" | undefined): Subject | undefined {
    const args = this.foldArgs(x, op, path);
    if (!args) return undefined;
    const inner = args[0];
    const innerOp = opOf(inner);
    if (outer === undefined && (innerOp === "casei" || innerOp === "accenti") && innerOp !== op) {
      return this.foldedSubject(inner as Json, innerOp, `${path}/args/0`, op);
    }
    if (!isPropertyRef(inner)) {
      this.notInProfile(inner, `${path}/args/0`, `Inside ${op}(…) on the left side`);
      return undefined;
    }
    const held = this.property(inner, `${path}/args/0`);
    if (held === undefined) return undefined;
    const name = inner.property as string;
    if (held !== "text" && held !== "any") {
      this.report("type-mismatch", `${path}/args/0`, `${op}(…) works on strings, and "${name}" ${WRITE[held]}.`);
      return undefined;
    }
    return { folded: true, name, held };
  }

  /** A property reference: its kind (`any` without queryables), or `undefined` after reporting a problem. */
  property(x: { property: unknown }, path: string): HeldKind | undefined {
    if (typeof x.property !== "string") {
      this.report("wrong-arguments", `${path}/property`, `"property" must be a string, the property's name.`);
      return undefined;
    }
    if (!this.#queryables) return "any";
    const q = Object.hasOwn(this.#queryables, x.property) ? this.#queryables[x.property] : undefined;
    if (q === undefined) {
      this.report(
        "unknown-property", path,
        `"${x.property}" is not a queryable here. The queryables: ${Object.keys(this.#queryables).join(", ") || "none"}.`,
      );
      return undefined;
    }
    return heldKind(q as Queryable);
  }

  /** Reports a literal that the subject's property can't be compared with. Returns whether it reported. */
  against(subject: Subject | undefined, kind: LiteralKind | undefined, path: string): boolean {
    if (!subject || !kind || subject.held === "any" || ACCEPTS[subject.held].includes(kind)) return false;
    this.report("type-mismatch", path, `"${subject.name}" ${WRITE[subject.held]}.`);
    return true;
  }

  /** A literal on the right. Returns its kind, or `undefined` after reporting why it isn't one. */
  literal(x: unknown, path: string): LiteralKind | undefined {
    if (typeof x === "string") return "string";
    if (typeof x === "boolean") return "boolean";
    if (typeof x === "number") {
      if (Number.isFinite(x)) return "number";
      this.report("invalid-number", path, `${x} is not a finite number; CQL2 has no literal for it.`);
      return undefined;
    }
    if (isObject(x) && "date" in x) {
      const m = typeof x.date === "string" ? DATE.exec(x.date) : null;
      if (m && isRealDay(+m[1]!, +m[2]!, +m[3]!)) return "date";
      this.report("invalid-date", `${path}/date`, `A date must be "YYYY-MM-DD" and exist, e.g. "2026-10-30".`);
      return undefined;
    }
    if (isObject(x) && "timestamp" in x) {
      const m = typeof x.timestamp === "string" ? TIMESTAMP.exec(x.timestamp) : null;
      // A leap second (:60) is refused: RFC 3339 allows it, but no engine here can compare it (JavaScript has none,
      // PostgreSQL rolls it over to the next minute), so it could not mean the same everywhere.
      if (m && isRealDay(+m[1]!, +m[2]!, +m[3]!) && +m[4]! <= 23 && +m[5]! <= 59 && +m[6]! <= 59) return "timestamp";
      this.report(
        "invalid-timestamp", `${path}/timestamp`,
        `A timestamp must be "YYYY-MM-DDThh:mm:ss[.fff]Z" (UTC) and exist, with seconds 00-59, e.g. "2026-10-30T12:00:00Z".`,
      );
      return undefined;
    }
    const op = opOf(x);
    if (op === "casei" || op === "accenti") return this.foldedLiteral(x as Json, op, path, undefined);
    this.notInProfile(x, path, "The right side");
    return undefined;
  }

  /** `casei('…')` / `accenti('…')` on the right: of a string, or of the other function of a string (once). */
  foldedLiteral(x: Json, op: "casei" | "accenti", path: string, outer: "casei" | "accenti" | undefined): LiteralKind | undefined {
    const args = this.foldArgs(x, op, path);
    if (!args) return undefined;
    const inner = args[0];
    const innerOp = opOf(inner);
    if (outer === undefined && (innerOp === "casei" || innerOp === "accenti") && innerOp !== op) {
      return this.foldedLiteral(inner as Json, innerOp, `${path}/args/0`, op);
    }
    if (typeof inner !== "string") {
      if (isObject(inner)) this.notInProfile(inner, `${path}/args/0`, `Inside ${op}(…) on the right side`);
      else this.report("type-mismatch", `${path}/args/0`, `"${op}" works on strings only.`);
      return undefined;
    }
    return "folded-string";
  }

  /** Reports an operand outside the profile, naming the class it would need, or invalid if it's not CQL2 at all. */
  notInProfile(x: unknown, path: string, where: string): void {
    const op = opOf(x);
    const { propertyProperty, arithmetic, functions, arrays, temporal, basicSpatial } =
      OTHER_CONFORMANCE;
    if (isPropertyRef(x)) {
      this.report(
        "outside-profile", path,
        `${where} is a property: comparing a property with a property needs the Property-Property Comparisons class.`,
        propertyProperty,
      );
    } else if (
      typeof x === "string" || typeof x === "number" || typeof x === "boolean" ||
      (isObject(x) && ("date" in x || "timestamp" in x))
    ) {
      this.report(
        "outside-profile", path,
        `${where} is a literal: a literal there needs the Property-Property Comparisons class.`, propertyProperty,
      );
    } else if (op !== undefined && ARITHMETIC.has(op)) {
      this.report("outside-profile", path, `"${op}" is arithmetic, not in the profile yet.`, arithmetic);
    } else if (op === "casei" || op === "accenti") {
      this.report(
        "outside-profile", path,
        `${where}: ${op}(…) is not in the profile here; casei(…) and accenti(…) may each wrap the other once.`,
      );
    } else if (op !== undefined) {
      this.report("outside-profile", path, `${where} is a function call ("${op}"): it needs the Functions class.`, functions);
    } else if (Array.isArray(x)) {
      this.report("outside-profile", path, `${where} is an array: arrays need the Array Functions class.`, arrays);
    } else if (isObject(x) && "interval" in x) {
      this.report("outside-profile", path, `${where} is an interval: it needs the Temporal Functions class.`, temporal);
    } else if (isObject(x) && ("type" in x || "bbox" in x)) {
      this.report("outside-profile", path, `${where} is a geometry: it needs a spatial functions class.`, basicSpatial);
    } else if (x === null) {
      // CQL2 has no null literal; a missing value is tested with IS NULL only.
      this.report(
        "wrong-arguments", path,
        `null is not a CQL2 literal. To test for a missing value, use isNull: { "op": "isNull", "args": [{ "property": ` +
          `"name" }] }. In a list, combine them: { "op": "or", "args": [in(…), isNull(…)] }.`,
      );
    } else {
      this.report("wrong-arguments", path, `${where} is neither a property nor a CQL2 literal.`);
    }
  }

  comparison(op: string, args: unknown[], path: string): void {
    this.uses(CONFORMANCE.basic, path, "A comparison");
    if (args.length !== 2) return this.report("wrong-arguments", `${path}/args`, `"${op}" needs exactly two arguments.`);
    const subject = this.subject(args[0], `${path}/args/0`);
    const kind = this.literal(args[1], `${path}/args/1`);
    // CASEI('x') against a plain property is valid: the property's value is then compared as it is.
    if (subject?.folded && kind && kind !== "string" && kind !== "folded-string") {
      this.report("type-mismatch", `${path}/args/1`, `${opOf(args[0])}(…) gives a string, so it can only be compared with a string.`);
    } else {
      this.against(subject, kind, `${path}/args/1`);
    }
  }

  like(args: unknown[], path: string): void {
    this.uses(CONFORMANCE.advancedComparison, path, "LIKE");
    if (args.length !== 2) return this.report("wrong-arguments", `${path}/args`, `"like" needs exactly two arguments.`);
    const subject = this.subject(args[0], `${path}/args/0`);
    const kind = this.literal(args[1], `${path}/args/1`);
    if (kind && kind !== "string" && kind !== "folded-string") {
      this.report("type-mismatch", `${path}/args/1`, `A LIKE pattern is a string, e.g. "Riv%".`);
    } else if (subject && subject.held !== "text" && subject.held !== "any") {
      this.report("type-mismatch", `${path}/args/0`, `LIKE works on strings, and "${subject.name}" ${WRITE[subject.held]}.`);
    }
  }

  between(args: unknown[], path: string): void {
    this.uses(CONFORMANCE.advancedComparison, path, "BETWEEN");
    if (args.length !== 3) {
      return this.report(
        "wrong-arguments", `${path}/args`, `"between" needs three arguments: a property, the low and the high value.`,
      );
    }
    let subject: Subject | undefined;
    if (opOf(args[0]) === "casei" || opOf(args[0]) === "accenti") {
      this.report("type-mismatch", `${path}/args/0`, `BETWEEN works on numbers only, and ${opOf(args[0])}(…) gives a string.`);
    } else {
      subject = this.subject(args[0], `${path}/args/0`, false);
    }
    let numbers = true;
    for (const i of [1, 2]) {
      const kind = this.literal(args[i], `${path}/args/${i}`);
      if (kind && kind !== "number") {
        this.report("type-mismatch", `${path}/args/${i}`, `BETWEEN works on numbers only.`);
        numbers = false;
      }
    }
    if (numbers && subject && subject.held !== "number" && subject.held !== "any") {
      this.report("type-mismatch", `${path}/args/0`, `BETWEEN works on numbers, and "${subject.name}" ${WRITE[subject.held]}.`);
    }
  }

  inList(args: unknown[], path: string): void {
    this.uses(CONFORMANCE.advancedComparison, path, "IN");
    if (args.length !== 2) {
      return this.report("wrong-arguments", `${path}/args`, `"in" needs two arguments: a property and a list.`);
    }
    const subject = this.subject(args[0], `${path}/args/0`);
    const list = args[1];
    if (!Array.isArray(list)) {
      return this.report("wrong-arguments", `${path}/args/1`, `The second argument of "in" is a list (an array) of literals.`);
    }
    if (list.length === 0) return this.report("empty-list", `${path}/args/1`, `An IN list needs at least one value.`);
    const kinds = new Set<LiteralKind>();
    list.forEach((item, i) => {
      const kind = this.literal(item, `${path}/args/1/${i}`);
      if (kind) kinds.add(kind === "folded-string" ? "string" : kind);
    });
    if (kinds.size > 1) {
      this.report(
        "mixed-list", `${path}/args/1`,
        `The values of an IN list must all be of one type; this one mixes ${[...kinds].join(", ")}.`,
      );
    } else if (subject?.folded && kinds.size === 1 && !kinds.has("string")) {
      this.report("type-mismatch", `${path}/args/1`, `${opOf(args[0])}(…) gives a string, so the list must hold strings.`);
    } else if (kinds.size === 1) {
      this.against(subject, [...kinds][0], `${path}/args/1`);
    }
  }

  isNull(args: unknown[], path: string): void {
    this.uses(CONFORMANCE.basic, path, "IS NULL");
    if (args.length !== 1) {
      return this.report("wrong-arguments", `${path}/args`, `"isNull" needs exactly one argument, a property.`);
    }
    if (isPropertyRef(args[0])) this.property(args[0], `${path}/args/0`);
    else this.report("outside-profile", `${path}/args/0`, `In the profile, IS NULL tests a property.`);
  }
}

/** Checks `value` against the profile. */
export function validate(value: unknown, options: ValidateOptions = {}): ValidationResult {
  const checker = new Checker(options);
  checker.filter(value, "");
  return checker.problems.length === 0
    ? { valid: true, filter: value as Cql2Filter }
    : { valid: false, problems: checker.problems };
}

/**
 * The same check, for code that wants the filter or an exception.
 *
 * @throws Cql2Error `invalid-filter`, with the first problem's message and path, and `details.problems` holding all.
 */
export function assertValid(value: unknown, options: ValidateOptions = {}): Cql2Filter {
  const result = validate(value, options);
  if (result.valid) return result.filter;
  const [first] = result.problems;
  throw new Cql2Error("invalid-filter", first!.message, first!.path, { problems: result.problems });
}

/**
 * The names of the properties a valid filter references, each once, in order of first appearance: to check them
 * against a collection's queryables, for example.
 */
export function filterProperties(filter: Cql2Filter): string[] {
  const names = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!isObject(x)) return;
    if (typeof x.property === "string") names.add(x.property);
    else if (Array.isArray(x.args)) walk(x.args);
  };
  walk(filter);
  return [...names];
}

/**
 * The profile's conformance classes a valid filter uses, in the order of {@link CONFORMANCE}, to compare with what a
 * server declares. Basic CQL2 is always among them.
 */
export function requiredConformance(filter: Cql2Filter): string[] {
  const used = new Set<string>([CONFORMANCE.basic]);
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!isObject(x)) return;
    if (x.op === "like" || x.op === "between" || x.op === "in") used.add(CONFORMANCE.advancedComparison);
    if (x.op === "casei") used.add(CONFORMANCE.caseInsensitive);
    if (x.op === "accenti") used.add(CONFORMANCE.accentInsensitive);
    if (Array.isArray(x.args)) walk(x.args);
  };
  walk(filter);
  return [CONFORMANCE.basic, CONFORMANCE.advancedComparison, CONFORMANCE.caseInsensitive, CONFORMANCE.accentInsensitive]
    .filter((c) => used.has(c));
}
