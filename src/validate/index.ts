/**
 * `ogc-cql2/validate`: checks that a value is a CQL2-JSON filter in the package's profile.
 *
 * Every problem comes with a stable code, a JSON Pointer to where it is, and a message. Valid CQL2 that the profile
 * doesn't cover is reported as `outside-profile`, naming the conformance class it would need, never as invalid.
 *
 * The rules are the standard's (OGC 21-065r2): its JSON Schema (`cql2.json`, tag `cql2-1.0.0`), its requirements,
 * and the permissions that let a server accept only a property on the left and a literal on the right.
 */
import { CONFORMANCE, CQL2_CONFORMANCE } from "../core/conformance.js";
import { Cql2Error } from "../core/errors.js";
import { heldKind, type HeldKind } from "../core/queryables.js";
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
  | "needs-conformance"
  /**
   * A geometry literal that isn't valid: coordinates out of range (CRS84: longitude −180…180, latitude −90…90), a
   * position of fewer than 2 or more than 3 numbers, a ring not closed or too short, a bbox of the wrong size…
   */
  | "invalid-geometry";

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
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** A geometry literal or a bbox: a GeoJSON `type`, or a `bbox` member alone. */
const isSpatialLiteral = (x: unknown): x is Json =>
  isObject(x) && (typeof x.type === "string" || ("bbox" in x && !("op" in x) && !("property" in x)));
const opOf = (x: unknown): string | undefined => (isObject(x) && typeof x.op === "string" ? x.op : undefined);
const argsOf = (x: Json): unknown[] | undefined => (Array.isArray(x.args) ? x.args : undefined);

/** The type of a literal on the right, for the type checks. */
type LiteralKind = "string" | "number" | "boolean" | "date" | "timestamp" | "folded-string";

/** The literals each kind of property can be compared with. */
const ACCEPTS: Readonly<Record<HeldKind, readonly LiteralKind[]>> = {
  text: ["string", "folded-string"],
  date: ["date"],
  instant: ["timestamp"],
  number: ["number"],
  boolean: ["boolean"],
  geometry: [],
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
  geometry: `is a geometry: test it with a spatial function, e.g. s_intersects, or with isNull`,
  other: `can't be compared in the profile; it can only be tested with isNull`,
};

/** A subject that passed the checks: whether it is `casei(…)` / `accenti(…)`, and its property's kind (`any` without queryables). */
interface Subject {
  readonly folded: boolean;
  readonly name: string;
  readonly held: HeldKind;
}

/** A side of a comparison that passed the checks: a property (a subject) or a literal (its kind). */
type Side =
  | { readonly subject: Subject; readonly path: string; readonly fold?: string }
  | { readonly literal: LiteralKind; readonly path: string };

/** A kind of literal, or of property, in the messages. */
const NAME: Readonly<Record<Exclude<LiteralKind, "folded-string"> | Exclude<HeldKind, "any">, string>> = {
  string: "a string", text: "a string", number: "a number", boolean: "a boolean", date: "a date", timestamp: "an instant",
  instant: "an instant", geometry: "a geometry", other: "a value the profile can't compare",
};

/** The literal kind a property of this kind is compared as, for two properties; `undefined` for any. */
const AS_LITERAL: Readonly<Partial<Record<HeldKind, LiteralKind>>> = {
  text: "string", number: "number", boolean: "boolean", date: "date", instant: "timestamp",
};

/** Whether `x` is `casei(…)` / `accenti(…)` with a property inside (one or two levels): a folded subject. */
const foldsProperty = (x: unknown): boolean => {
  for (let i = 0; i < 2 && (opOf(x) === "casei" || opOf(x) === "accenti"); i++) x = argsOf(x as Json)?.[0];
  return isPropertyRef(x);
};

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

    if (SPATIAL.has(op)) return this.spatial(op, args, path);
    if (TEMPORAL.has(op)) {
      return this.report(
        "outside-profile", path, `"${op}" is a temporal function, not in the profile yet.`, CQL2_CONFORMANCE.temporal,
      );
    }
    if (ARRAY.has(op)) {
      return this.report(
        "outside-profile", path, `"${op}" is an array function, not in the profile yet.`, CQL2_CONFORMANCE.arrays,
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
      CQL2_CONFORMANCE.functions,
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

  /** A literal (on the right, unless `where` says). Returns its kind, or `undefined` after reporting why it isn't one. */
  literal(x: unknown, path: string, where = "The right side"): LiteralKind | undefined {
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
    this.notInProfile(x, path, where);
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
    const { propertyProperty, arithmetic, functions, arrays, temporal } = CQL2_CONFORMANCE;
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
      this.report("wrong-arguments", path, `${where} is a geometry: a geometry goes in a spatial function, e.g. s_intersects.`);
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

  /**
   * Either side of a comparison: a property, `casei(…)` / `accenti(…)` of a property or a string, or a literal. With a
   * property on the right or a literal on the left, the comparison uses Property-Property Comparisons.
   */
  side(x: unknown, path: string, where: string): Side | undefined {
    if (isPropertyRef(x) || foldsProperty(x)) {
      const subject = this.subject(x, path);
      return subject && { subject, path, ...(subject.folded ? { fold: opOf(x)! } : {}) };
    }
    const kind = this.literal(x, path, where);
    return kind && { literal: kind, path };
  }

  /** Notes a side that the portable shape (a property on the left, literals on the right) doesn't allow. */
  propertyProperty(sides: readonly (Side | undefined)[], path: string): void {
    const [left, ...rest] = sides;
    if ((left && "literal" in left) || rest.some((side) => side && "subject" in side)) {
      this.uses(CONFORMANCE.propertyProperty, path, "A literal on the left, or a property on the right,");
    }
  }

  /** Reports two sides whose types can't match (the second side's path). */
  match(a: Side, b: Side): void {
    if ("subject" in a && "literal" in b) return this.matchLiteral(a, b.literal, b.path);
    if ("literal" in a && "subject" in b) return this.matchLiteral(b, a.literal, a.path);
    if ("literal" in a && "literal" in b) {
      const plain = (k: LiteralKind) => (k === "folded-string" ? "string" : k);
      if (plain(a.literal) !== plain(b.literal)) {
        const folded = a.literal === "folded-string" || b.literal === "folded-string";
        const other = plain(a.literal === "folded-string" ? b.literal : a.literal) as Exclude<LiteralKind, "folded-string">;
        this.report(
          "type-mismatch", b.path,
          folded
            ? `casei(…) and accenti(…) give a string, so the other side must be a string, not ${NAME[other]}.`
            : `${NAME[plain(a.literal) as "string"]} can't be compared with ${NAME[plain(b.literal) as "string"]}.`,
        );
      }
      return;
    }
    const [x, y] = [(a as { subject: Subject }).subject, (b as { subject: Subject }).subject];
    if (x.held === "any" || y.held === "any") return;
    if (x.held === y.held && AS_LITERAL[x.held]) return;
    this.report(
      "type-mismatch", b.path,
      x.held === y.held
        ? `"${y.name}" ${WRITE[y.held as Exclude<HeldKind, "any">]}.`
        : `"${x.name}" holds ${NAME[x.held as Exclude<HeldKind, "any">]} and "${y.name}" ${NAME[y.held as Exclude<HeldKind, "any">]}: they can't be compared.`,
    );
  }

  /**
   * A property side against a literal (reported at the literal's path). CASEI('x') against a plain property is valid:
   * the property's value is then compared as it is.
   */
  matchLiteral(side: { subject: Subject; fold?: string }, kind: LiteralKind, path: string): void {
    if (side.fold && kind !== "string" && kind !== "folded-string") {
      this.report("type-mismatch", path, `${side.fold}(…) gives a string, so it can only be compared with a string.`);
    } else {
      this.against(side.subject, kind, path);
    }
  }

  comparison(op: string, args: unknown[], path: string): void {
    this.uses(CONFORMANCE.basic, path, "A comparison");
    if (args.length !== 2) return this.report("wrong-arguments", `${path}/args`, `"${op}" needs exactly two arguments.`);
    const left = this.side(args[0], `${path}/args/0`, "The left side");
    const right = this.side(args[1], `${path}/args/1`, "The right side");
    this.propertyProperty([left, right], path);
    if (left && right) this.match(left, right);
  }

  like(args: unknown[], path: string): void {
    this.uses(CONFORMANCE.advancedComparison, path, "LIKE");
    if (args.length !== 2) return this.report("wrong-arguments", `${path}/args`, `"like" needs exactly two arguments.`);
    const left = this.side(args[0], `${path}/args/0`, "The left side");
    this.propertyProperty([left], path);
    // The grammar's `patternExpression`: a string, under CASEI / ACCENTI at most, never a property.
    if (isPropertyRef(args[1]) || foldsProperty(args[1])) {
      this.report("wrong-arguments", `${path}/args/1`, `A LIKE pattern is a string literal, e.g. "Riv%", never a property.`);
      return;
    }
    const kind = this.literal(args[1], `${path}/args/1`);
    if (kind && kind !== "string" && kind !== "folded-string") {
      this.report("type-mismatch", `${path}/args/1`, `A LIKE pattern is a string, e.g. "Riv%".`);
    } else if (left && "literal" in left && left.literal !== "string" && left.literal !== "folded-string") {
      this.report("type-mismatch", `${path}/args/0`, `LIKE works on strings.`);
    } else if (left && "subject" in left && left.subject.held !== "text" && left.subject.held !== "any") {
      this.report("type-mismatch", `${path}/args/0`, `LIKE works on strings, and "${left.subject.name}" ${WRITE[left.subject.held]}.`);
    }
  }

  between(args: unknown[], path: string): void {
    this.uses(CONFORMANCE.advancedComparison, path, "BETWEEN");
    if (args.length !== 3) {
      return this.report(
        "wrong-arguments", `${path}/args`, `"between" needs three arguments: a property, the low and the high value.`,
      );
    }
    const sides = args.map((x, i) => {
      const at = `${path}/args/${i}`;
      if (opOf(x) === "casei" || opOf(x) === "accenti") {
        this.report("type-mismatch", at, `BETWEEN works on numbers only, and ${opOf(x)}(…) gives a string.`);
        return undefined;
      }
      return this.side(x, at, i === 0 ? "The left side" : "The right side");
    });
    this.propertyProperty(sides, path);
    for (const side of sides) {
      if (side && "literal" in side && side.literal !== "number") {
        this.report("type-mismatch", side.path, `BETWEEN works on numbers only.`);
      } else if (side && "subject" in side && side.subject.held !== "number" && side.subject.held !== "any") {
        this.report("type-mismatch", side.path, `BETWEEN works on numbers, and "${side.subject.name}" ${WRITE[side.subject.held]}.`);
      }
    }
  }

  inList(args: unknown[], path: string): void {
    this.uses(CONFORMANCE.advancedComparison, path, "IN");
    if (args.length !== 2) {
      return this.report("wrong-arguments", `${path}/args`, `"in" needs two arguments: a property and a list.`);
    }
    const left = this.side(args[0], `${path}/args/0`, "The left side");
    const list = args[1];
    if (!Array.isArray(list)) {
      return this.report("wrong-arguments", `${path}/args/1`, `The second argument of "in" is a list (an array) of literals.`);
    }
    if (list.length === 0) return this.report("empty-list", `${path}/args/1`, `An IN list needs at least one value.`);
    const items = list.map((item, i) => this.side(item, `${path}/args/1/${i}`, "An item of the IN list"));
    this.propertyProperty([left, ...items], path);
    const kinds = new Set<LiteralKind>();
    for (const item of items) if (item && "literal" in item) kinds.add(item.literal === "folded-string" ? "string" : item.literal);
    if (kinds.size > 1) {
      return this.report(
        "mixed-list", `${path}/args/1`,
        `The values of an IN list must all be of one type; this one mixes ${[...kinds].join(", ")}.`,
      );
    }
    if (!left) return;
    // The literals once, as the list's type (as before); each property item on its own.
    const literal = items.find((item): item is Side & { literal: LiteralKind } => item !== undefined && "literal" in item);
    if (literal) {
      if ("subject" in left && left.subject.folded && literal.literal !== "string" && literal.literal !== "folded-string") {
        this.report("type-mismatch", `${path}/args/1`, `${opOf(args[0])}(…) gives a string, so the list must hold strings.`);
      } else {
        this.match(left, { literal: kinds.values().next().value!, path: `${path}/args/1` });
      }
    }
    for (const item of items) if (item && "subject" in item) this.match(left, item);
  }

  /**
   * A spatial relation: a geometry property first, a geometry literal second; with Property-Property Comparisons, a
   * property or a literal in either place. The class: S_INTERSECTS with points or boxes (or no literal) is Basic
   * Spatial Functions, with any other geometry Basic plus; any other relation Spatial Functions.
   */
  spatial(op: string, args: unknown[], path: string): void {
    const what = op.toUpperCase();
    if (args.length !== 2) {
      return this.report("wrong-arguments", `${path}/args`, `"${op}" needs two arguments: a property and a geometry.`);
    }
    const kinds: ("point-or-box" | "other" | undefined)[] = [];
    let valid = true;
    args.forEach((x, i) => {
      const at = `${path}/args/${i}`;
      if (isPropertyRef(x)) {
        const held = this.property(x, at);
        if (held !== undefined && held !== "geometry" && held !== "any") {
          this.report("type-mismatch", at, `${what} tests a geometry, and "${x.property}" isn't one.`);
        }
      } else if (isSpatialLiteral(x)) {
        const kind = this.spatialLiteral(x, at);
        if (kind === undefined) valid = false;
        kinds.push(kind);
      } else {
        this.notInProfile(x, at, `The ${i === 0 ? "first" : "second"} argument of ${what}`);
        valid = false;
      }
    });
    if (!isPropertyRef(args[0]) || isPropertyRef(args[1])) {
      this.uses(CONFORMANCE.propertyProperty, path, `${what} with a literal first, or a property second,`);
    }
    if (!valid) return;
    const conformance = op !== "s_intersects" ? CONFORMANCE.spatial
      : kinds.every((k) => k === "point-or-box") ? CONFORMANCE.basicSpatial : CONFORMANCE.basicSpatialPlus;
    this.uses(conformance, path, what);
  }

  /** A geometry literal or a bbox: whether it is a point or a box (Basic) or another geometry; `undefined` if invalid. */
  spatialLiteral(x: Json, path: string): "point-or-box" | "other" | undefined {
    const before = this.problems.length;
    if (!("type" in x)) {
      this.bbox(x.bbox, `${path}/bbox`);
      return this.problems.length === before ? "point-or-box" : undefined;
    }
    this.geometry(x, path, true);
    if (this.problems.length !== before) return undefined;
    return x.type === "Point" ? "point-or-box" : "other";
  }

  invalidGeometry(path: string, message: string): void {
    this.report("invalid-geometry", path, message);
  }

  /** A GeoJSON geometry: its type, its coordinates, and its own optional GeoJSON `bbox`. */
  geometry(x: Json, path: string, collectionAllowed: boolean): void {
    if ("bbox" in x) {
      // GeoJSON allows it, but CQL2's schema doesn't: a literal is a geometry *or* a bbox (`oneOf`), and an object
      // with both "type" and "bbox" is both.
      this.invalidGeometry(`${path}/bbox`, `A geometry literal can't carry its own "bbox" in CQL2-JSON: leave it out.`);
    }
    const c = x.coordinates;
    switch (x.type) {
      case "Point":
        return this.position(c, `${path}/coordinates`);
      case "LineString":
      case "MultiPoint":
        return this.positions(c, `${path}/coordinates`, x.type === "LineString" ? 2 : 1, x.type);
      case "Polygon":
        return this.polygon(c, `${path}/coordinates`);
      case "MultiLineString":
        if (!this.list(c, `${path}/coordinates`, 1, "A MultiLineString's coordinates are a list of LineStrings")) return;
        return (c as unknown[]).forEach((line, i) => this.positions(line, `${path}/coordinates/${i}`, 2, "LineString"));
      case "MultiPolygon":
        if (!this.list(c, `${path}/coordinates`, 1, "A MultiPolygon's coordinates are a list of Polygons")) return;
        return (c as unknown[]).forEach((polygon, i) => this.polygon(polygon, `${path}/coordinates/${i}`));
      case "GeometryCollection": {
        if (!collectionAllowed) {
          return this.invalidGeometry(path, `A GeometryCollection can't hold another GeometryCollection.`);
        }
        const members = x.geometries;
        if (!this.list(members, `${path}/geometries`, 2, `A GeometryCollection holds two or more geometries`)) return;
        return (members as unknown[]).forEach((g, i) => {
          if (isObject(g) && typeof g.type === "string") this.geometry(g, `${path}/geometries/${i}`, false);
          else this.invalidGeometry(`${path}/geometries/${i}`, `This isn't a GeoJSON geometry.`);
        });
      }
      default:
        return this.invalidGeometry(
          `${path}/type`,
          `"${String(x.type)}" isn't a GeoJSON geometry type: Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon or GeometryCollection.`,
        );
    }
  }

  /** An array of at least `min` items; reports and returns false otherwise. */
  list(x: unknown, path: string, min: number, what: string): boolean {
    if (Array.isArray(x) && x.length >= min) return true;
    this.invalidGeometry(path, `${what}${min > 1 ? ` (at least ${min})` : ""}.`);
    return false;
  }

  /** A position: 2 or 3 finite numbers, longitude −180…180 and latitude −90…90 (CRS84). */
  position(x: unknown, path: string): void {
    if (!Array.isArray(x) || x.length < 2 || x.length > 3 || !x.every(isFiniteNumber)) {
      return this.invalidGeometry(path, `A position is 2 or 3 numbers: longitude, latitude and optionally a height.`);
    }
    const [lon, lat] = x as number[];
    if (lon! < -180 || lon! > 180) this.invalidGeometry(`${path}/0`, `Longitude ${lon} is outside −180…180 (CRS84: longitude first).`);
    if (lat! < -90 || lat! > 90) this.invalidGeometry(`${path}/1`, `Latitude ${lat} is outside −90…90 (CRS84: latitude second).`);
  }

  positions(x: unknown, path: string, min: number, what: string): void {
    if (!this.list(x, path, min, `A ${what} needs ${min === 1 ? "one or more positions" : `${min} or more positions`}`)) return;
    (x as unknown[]).forEach((p, i) => this.position(p, `${path}/${i}`));
  }

  /** A Polygon's rings: each 4 or more positions, its last equal to its first. */
  polygon(x: unknown, path: string): void {
    if (!this.list(x, path, 1, "A Polygon's coordinates are a list of rings: the outer ring, then any holes")) return;
    (x as unknown[]).forEach((ring, i) => {
      const at = `${path}/${i}`;
      if (!Array.isArray(ring) || ring.length < 4) {
        return this.invalidGeometry(at, `A ring needs 4 or more positions, the last the same as the first.`);
      }
      const before = this.problems.length;
      ring.forEach((p, j) => this.position(p, `${at}/${j}`));
      if (this.problems.length !== before) return;
      const first = ring[0] as number[];
      const last = ring[ring.length - 1] as number[];
      if (first.length !== last.length || first.some((v, k) => v !== last[k])) {
        this.invalidGeometry(`${at}/${ring.length - 1}`, `A ring is closed: its last position must be the same as its first.`);
      }
    });
  }

  /** `[west, south, east, north]` or `[west, south, min, east, north, max]`; west > east crosses the antimeridian. */
  bbox(x: unknown, path: string): void {
    if (!Array.isArray(x) || (x.length !== 4 && x.length !== 6) || !x.every(isFiniteNumber)) {
      return this.invalidGeometry(
        path, `A bbox is 4 numbers, [west, south, east, north], or 6 with heights, [west, south, min, east, north, max].`,
      );
    }
    const n = x as number[];
    const [west, south, east, north] = n.length === 4 ? n : [n[0], n[1], n[3], n[4]];
    for (const [value, i] of [[west, 0], [east, n.length === 4 ? 2 : 3]] as const) {
      if (value! < -180 || value! > 180) this.invalidGeometry(`${path}/${i}`, `Longitude ${value} is outside −180…180.`);
    }
    for (const [value, i] of [[south, 1], [north, n.length === 4 ? 3 : 4]] as const) {
      if (value! < -90 || value! > 90) this.invalidGeometry(`${path}/${i}`, `Latitude ${value} is outside −90…90.`);
    }
    if (south! > north!) this.invalidGeometry(path, `A bbox's south (${south}) is above its north (${north}).`);
    if (n.length === 6 && n[2]! > n[5]!) this.invalidGeometry(path, `A bbox's minimum height (${n[2]}) is above its maximum (${n[5]}).`);
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

/** Whether a comparison, LIKE, BETWEEN or IN has a literal on the left or a property on the right. */
function isPropertyProperty(x: Json): boolean {
  const op = x.op as string;
  if (!(COMPARISON.has(op) || op === "like" || op === "between" || op === "in") || !Array.isArray(x.args)) return false;
  const [left, ...rest] = x.args as unknown[];
  const right = op === "in" && Array.isArray(rest[0]) ? (rest[0] as unknown[]) : rest;
  const reads = (y: unknown) => isPropertyRef(y) || foldsProperty(y);
  return !reads(left) || right.some(reads);
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
    if (isPropertyProperty(x)) used.add(CONFORMANCE.propertyProperty);
    if (typeof x.op === "string" && SPATIAL.has(x.op) && Array.isArray(x.args)) {
      const literals = x.args.filter((a) => isObject(a) && !isPropertyRef(a)) as Json[];
      const pointOrBox = literals.every((l) => l.type === "Point" || !("type" in l));
      used.add(x.op !== "s_intersects" ? CONFORMANCE.spatial : pointOrBox ? CONFORMANCE.basicSpatial : CONFORMANCE.basicSpatialPlus);
      if (!isPropertyRef(x.args[0]) || isPropertyRef(x.args[1])) used.add(CONFORMANCE.propertyProperty);
      return; // a geometry literal holds no other class
    }
    if (Array.isArray(x.args)) walk(x.args);
  };
  walk(filter);
  return Object.values(CONFORMANCE).filter((c) => used.has(c));
}
