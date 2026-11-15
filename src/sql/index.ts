/**
 * `ogc-cql2/sql`: CQL2-JSON → a parameterized SQL `WHERE` clause. It builds text and values only: it never imports a
 * driver or runs a query. The application runs the SQL with its own driver.
 *
 * The rule: the SQL selects exactly the rows `ogc-cql2/evaluate` selects from the values the application serves. The
 * differential tests check that against real databases.
 *
 * One walker (`toSql`) for every dialect; what differs per database is in `dialects/`, one file each:
 * - `sqlite`, following GeoPackage: typed views, and registered functions ({@link sqliteFunctions});
 * - `postgres`, for PostgreSQL and PostGIS tables: {@link postgresValue}, {@link postgresFunctions};
 * - `duckdb`, for DuckDB in Node and in the browser: {@link duckdbValue}, {@link duckdbFunctions};
 * - `oracle`, for Oracle Database 23ai and later (Oracle Spatial): {@link oracleValue}, {@link oracleFunctions};
 * - `sqlserver`, for SQL Server 2022 and later, with Basic Spatial Functions: {@link sqlserverValue},
 *   {@link sqlserverFunctions}.
 *
 * The typed views and functions keep the results exact, at a cost: the database can't use a plain index for those
 * predicates.
 */
import { Cql2Error } from "../core/errors.js";
import { unwrap } from "../core/folds.js";
import { heldKind, type HeldKind } from "../core/queryables.js";
import { CONVERSE } from "../core/relate.js";
import { OPEN, RELATIONS, isTemporal, type End } from "../core/temporal.js";
import type {
  ArithmeticOperand, Cql2Filter, FoldedString, IntervalEnd, PropertyRef, ScalarLiteral, SpatialLiteral, SpatialOperator,
  StringSubject, TemporalOperand, TemporalPredicate,
} from "../core/types.js";
import { toEvaluator } from "../evaluate/index.js";
import { intersects, literalParts } from "../evaluate/spatial.js";
import { dayNumber, foldKey, instantOf } from "../evaluate/strings.js";
import { implementedBut, refuseUnsupported } from "../core/unsupported.js";
import { compute, isArithmetic, readsProperty } from "../core/arithmetic.js";
import { CONFORMANCE } from "../core/conformance.js";
import { assertValid, requiredConformance } from "../validate/index.js";
import { duckdb } from "./dialects/duckdb.js";
import { oracle } from "./dialects/oracle.js";
import { sqlserver } from "./dialects/sqlserver.js";
import { postgres } from "./dialects/postgres.js";
import { sqlite } from "./dialects/sqlite.js";
import {
  quote, type Dialect, type Kind, type PairSide, type SqlColumn, type SqlOptions, type SqlValue, type SqlWhere, type View,
} from "./types.js";

export type { SqlColumn, SqlDialect, SqlOptions, SqlValue, SqlWhere } from "./types.js";
export { sqliteFunctions } from "./dialects/sqlite.js";
export { postgresFunctions, postgresValue } from "./dialects/postgres.js";
export { duckdbFunctions, duckdbValue, type DuckdbFunction } from "./dialects/duckdb.js";
export { oracleFunctions, oracleValue } from "./dialects/oracle.js";
export { sqlserverFunctions, sqlserverValue } from "./dialects/sqlserver.js";

const DIALECTS: Readonly<Record<SqlOptions["dialect"], Dialect>> = { sqlite, postgres, duckdb, oracle, sqlserver };

/** `a op b` is `b MIRROR[op] a`. */
const MIRROR: Readonly<Record<string, string>> = { "=": "=", "<>": "<>", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };

/** `a op b`, given the sign of comparing a with b. */
const ORDERED: Readonly<Record<string, (o: number) => boolean>> = {
  "=": (o) => o === 0, "<": (o) => o < 0, ">": (o) => o > 0, "<=": (o) => o <= 0, ">=": (o) => o >= 0,
};

/** A condition: decided when the SQL is built, or SQL, written when called (parameters are added in SQL order). */
type Condition = boolean | (() => string);
const all = (cs: readonly Condition[]): Condition => {
  const rest = cs.filter((c) => c !== true) as (() => string)[];
  return cs.includes(false) ? false : rest.length === 0 ? true : () => rest.map((c) => (rest.length === 1 ? c() : `(${c()})`)).join(" AND ");
};
const any = (cs: readonly Condition[]): Condition => {
  const rest = cs.filter((c) => c !== false) as (() => string)[];
  return cs.includes(true) ? true : rest.length === 0 ? false : () => rest.map((c) => (rest.length === 1 ? c() : `(${c()})`)).join(" OR ");
};

/** What two properties compared with each other can hold, when their queryables say. */
const COMPARABLE: ReadonlySet<HeldKind> = new Set(["text", "number", "boolean", "date", "instant"]);

/** A side that reads the table, an arithmetic expression with a property in it included. */
const readsAny = (x: ArithmeticOperand): boolean => (isArithmetic(x) ? readsProperty(x) : reads(x));

/** A side that reads the table: a property, or CASEI / ACCENTI of one (not of a string). */
const reads = (x: ArithmeticOperand): x is StringSubject =>
  typeof x === "object" && !isArithmetic(x) && ("property" in x || ("op" in x && typeof unwrap(x as FoldedString).inner !== "string"));

/** `relate`, when the dialect evaluates Spatial Functions with these options (SQLite only with SpatiaLite). */
const relateOf = (options: Pick<SqlOptions, "dialect" | "spatialite">): Dialect["relate"] =>
  options.dialect === "sqlite" && options.spatialite !== true ? undefined : DIALECTS[options.dialect].relate;

/**
 * The conformance classes `toSql` translates with these options, as URIs (as in `CONFORMANCE`): every class the
 * package implements on `postgres`, `duckdb` and `oracle`, on `sqlite` all but Spatial Functions unless `spatialite`
 * is `true`, and on `sqlserver` all but Spatial Functions. Pass it to `validate` (`{ conformance }`) to refuse up front, as `needs-conformance`, what
 * `toSql` would refuse as `unsupported`; a filter valid against it never is. It says what the SQL needs, not what the
 * database has: the spatial classes also need PostGIS, DuckDB's spatial extension or Oracle Spatial, and the package's
 * functions installed (`postgresFunctions`, `duckdbFunctions`, `sqliteFunctions`, `oracleFunctions`). A new array, in
 * `CONFORMANCE`'s order, to change at will.
 */
export function sqlConformance(options: Omit<SqlOptions, "columns"> & Partial<Pick<SqlOptions, "columns">>): string[] {
  // A dialect with spatial SQL evaluates S_INTERSECTS (the two basic classes), and with `relate` Spatial Functions too.
  if (relateOf(options)) return implementedBut([]);
  if (DIALECTS[options.dialect].intersects) return implementedBut([CONFORMANCE.spatial]);
  return implementedBut([CONFORMANCE.basicSpatial, CONFORMANCE.basicSpatialPlus, CONFORMANCE.spatial]);
}

/**
 * Builds the `WHERE` condition and its values.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 * @throws Cql2Error `unknown-property` for a property not in `options.columns`.
 * @throws Cql2Error `unsupported` for a filter of a class not in {@link sqlConformance}: Spatial Functions on `sqlite`
 * without `spatialite` (S_DISJOINT included).
 */
export function toSql(filter: Cql2Filter, options: SqlOptions): SqlWhere {
  const valid = assertValid(filter);
  const dialect = DIALECTS[options.dialect];
  refuseUnsupported(requiredConformance(valid), sqlConformance(options), `ogc-cql2/sql (${options.dialect})`);
  const params: SqlValue[] = [];
  const param = (value: SqlValue, cast = ""): string => {
    params.push(value);
    return `${dialect.placeholder(params.length)}${cast}`;
  };
  const schema = options.functionSchema ?? dialect.functionSchema;
  const fn = (name: string): string => (schema ? `${quote(schema)}.${name}` : name);

  const columnOf = (ref: PropertyRef, path: string): { column: SqlColumn; sql: string } => {
    const column = Object.hasOwn(options.columns, ref.property) ? options.columns[ref.property] : undefined;
    if (!column) {
      throw new Cql2Error("unknown-property", `"${ref.property}" is not a column of this table.`, path, {
        property: ref.property,
      });
    }
    return { column, sql: quote(column.column ?? ref.property) };
  };

  /**
   * The subject (a property, or CASEI / ACCENTI of one) read as `kind`; `undefined` when no value can be of that kind.
   * Under CASEI or ACCENTI it is read folded: validate allows them only against strings.
   */
  const subject = (x: StringSubject, kind: Kind, path: string): View | undefined => {
    const { inner, folds } = unwrap(x);
    const { column, sql } = columnOf(inner, path + "/args/0".repeat(folds.length));
    return folds.length === 0 ? dialect.view(sql, kind, column, fn, folds) : dialect.view(sql, "fold", column, fn, folds);
  };

  /** A literal's kind and its SQL value, keyed exactly as `evaluate` keys it. */
  const literal = (x: ScalarLiteral | FoldedString): { kind: Kind; value: SqlValue } => {
    if (typeof x === "string") return { kind: "text", value: foldKey(x, []) };
    if (typeof x === "number") return { kind: "number", value: x };
    if (typeof x === "boolean") return { kind: "boolean", value: dialect.boolean(x) };
    if ("op" in x) {
      const { inner, folds } = unwrap(x);
      return { kind: "fold", value: foldKey(inner, folds) };
    }
    if ("date" in x) return { kind: "day", value: x.date };
    return { kind: "instant", value: dialect.instant(instantOf(x.timestamp)!) }; // validate has checked it is one
  };

  /**
   * Conditions as values: `CASE WHEN guard THEN condition END`, and the first of several that isn't NULL. A database
   * without boolean values (Dialect.truth) writes them as 1 / 0 / NULL, compared with 1.
   */
  const caseWhen = (guard: string, condition: string): string =>
    dialect.truth ? `CASE WHEN ${guard} THEN ${dialect.truth(condition)} END = 1` : `CASE WHEN ${guard} THEN ${condition} END`;
  const coalesce = (conditions: readonly string[]): string =>
    dialect.truth ? `COALESCE(${conditions.map(dialect.truth).join(", ")}) = 1` : `COALESCE(${conditions.join(", ")})`;

  /** A literal's value as a parameter of the view. */
  const valueParam = (v: View, value: SqlValue): string => {
    const p = param(v.value ? v.value(value) : value, v.cast);
    return v.wrap ? v.wrap(p, value) : p;
  };
  /**
   * `view op ''` where the database reads `''` as NULL (Dialect.emptyStringIsNull): no value is `''`, so it is
   * FALSE (`= < <=`) or TRUE (`<> > >=`) for a value, NULL for none, with no parameter.
   */
  const emptyString = (v: View, op: string): string => `${v.sql} ${op === "=" || op === "<" || op === "<=" ? "<>" : "="} ${v.sql}`;
  const isEmptyString = (value: SqlValue): boolean => value === "" && dialect.emptyStringIsNull === true;
  const compare = (v: View, op: string, p: string): string => (v.compare ? v.compare(op, p) : `${v.sql} ${op} ${p}`);
  /**
   * A view's condition on literals, an infinite value (`View.finite`) taken as NULL, as `evaluate` takes it. Under an
   * even number of NOTs FALSE selects the same rows as NULL, under an odd number TRUE does (see Dialect.intersects), so
   * the column stays alone on its side and keeps its index (a CASE would lose it).
   */
  const bounded = (v: View, condition: string, positive: boolean): string =>
    v.finite === undefined ? condition : positive ? `(${condition} AND ${v.finite})` : `(${condition} OR NOT ${v.finite})`;

  // A folded literal compares text: the column's text view, or its folded view under CASEI / ACCENTI (property).
  const viewKind = (kind: Kind): Kind => (kind === "fold" ? "text" : kind);

  /** A filter of literals only (Property-Property Comparisons): decided here, exactly as `evaluate` decides it. */
  const constant = (f: Cql2Filter): string => {
    const truth = toEvaluator(f)(undefined);
    return truth === null ? dialect.never : truth ? dialect.true : dialect.false; // NULL: an interval beginning after it ends
  };

  /**
   * A number for arithmetic (Arithmetic Expressions): a constant (an expression of literals, computed here as
   * `evaluate` computes it; `null` for NULL), or SQL built when `emit` is called, so that its parameters are added in
   * the order they stand in the SQL, and only once the whole expression is known not to be NULL.
   */
  type Num = { readonly value: number | null } | { readonly emit: () => string };
  const emit = (n: Num): string => ("emit" in n ? n.emit() : dialect.number(n.value!, param));
  /** A number operand; `undefined` for a column that can hold no number (NULL). */
  const numeric = (x: ArithmeticOperand, path: string): Num | undefined => {
    if (typeof x === "number") return { value: x };
    if (isArithmetic(x)) {
      if (!readsProperty(x)) return { value: compute(x, () => null) };
      const [a, b] = [numeric(x.args[0], `${path}/args/0`), numeric(x.args[1], `${path}/args/1`)];
      if (!a || !b || ("value" in a && a.value === null) || ("value" in b && b.value === null)) return undefined;
      return { emit: () => dialect.arithmetic(x.op, emit(a), emit(b), fn) };
    }
    const v = subject(x as StringSubject, "number", path); // validate allows no CASEI / ACCENTI here
    return v && { emit: () => v.sql };
  };
  /** `a op b` with an arithmetic expression on either side. */
  const arithmeticComparison = (a: ArithmeticOperand, op: string, b: ArithmeticOperand, pathA: string, pathB: string): string => {
    const [na, nb] = [numeric(a, pathA), numeric(b, pathB)];
    if (!na || !nb || ("value" in na && na.value === null) || ("value" in nb && nb.value === null)) return dialect.never;
    if ("value" in na && "value" in nb) return constant({ op, args: [na.value, nb.value] } as Cql2Filter);
    return `${emit(na)} ${op} ${emit(nb)}`;
  };

  /**
   * `a op b`, each side a property (or CASEI / ACCENTI of one), a literal, or an arithmetic expression. A literal on
   * the left is the property on the left with the operator mirrored, so a property against a literal is always written
   * one way.
   */
  const comparison = (a: ArithmeticOperand, op: string, b: ArithmeticOperand, pathA: string, pathB: string, positive: boolean): string => {
    if (isArithmetic(a) || isArithmetic(b)) return arithmeticComparison(a, op, b, pathA, pathB);
    if (!reads(a) && !reads(b)) return constant({ op, args: [a, b] } as Cql2Filter);
    if (!reads(a)) return comparison(b, MIRROR[op]!, a, pathB, pathA, positive);
    if (!reads(b)) {
      const lit = literal(b);
      const v = subject(a, viewKind(lit.kind), pathA);
      if (v === undefined) return dialect.never;
      return isEmptyString(lit.value) ? emptyString(v, op) : bounded(v, compare(v, op, valueParam(v, lit.value)), positive);
    }
    return properties(a, op, b, pathA, pathB);
  };

  /**
   * Two properties compared with each other, as `evaluate` compares them given the columns as its queryables: under
   * CASEI / ACCENTI as text; as days or instants when either queryable says `date` or `date-time`; otherwise by the
   * values' own types, each kind both columns can hold compared in its view (a value has one kind, so at most one of
   * them isn't NULL: COALESCE).
   *
   * @throws Cql2Error `invalid-filter` for two columns whose queryables hold kinds that can't be compared.
   */
  const properties = (a: StringSubject, op: string, b: StringSubject, pathA: string, pathB: string): string => {
    const [ua, ub] = [unwrap(a), unwrap(b)];
    const ca = columnOf(ua.inner, pathA + "/args/0".repeat(ua.folds.length));
    const cb = columnOf(ub.inner, pathB + "/args/0".repeat(ub.folds.length));
    const [ha, hb] = [heldKind(ca.column), heldKind(cb.column)];
    if (ha !== "any" && hb !== "any" && (ha !== hb || !COMPARABLE.has(ha))) {
      throw new Cql2Error(
        "invalid-filter", `"${ua.inner.property}" (${ha}) and "${ub.inner.property}" (${hb}) can't be compared.`, pathB,
      );
    }
    const fixed = [ha, hb].find((h) => h === "date" || h === "instant");
    const kinds: Kind[] = ua.folds.length > 0 || ub.folds.length > 0 ? ["text"]
      : fixed === "date" ? ["day"] : fixed === "instant" ? ["instant"] : ["text", "number", "boolean"];
    const view = (u: typeof ua, c: typeof ca, kind: Kind) =>
      u.folds.length > 0 ? dialect.view(c.sql, "fold", c.column, fn, u.folds) : dialect.view(c.sql, kind, c.column, fn, []);
    const parts = kinds.flatMap((kind) => {
      const [va, vb] = [view(ua, ca, kind), view(ub, cb, kind)];
      return va && vb ? [dialect.compareViews?.(va, op, vb) ?? `${va.pair ?? va.sql} ${op} ${vb.pair ?? vb.sql}`] : [];
    });
    return parts.length === 0 ? dialect.never : parts.length === 1 ? parts[0]! : coalesce(parts);
  };

  /** `op(property, literal)`, the property at `refPath`. */
  const spatialLeaf = (op: SpatialOperator, ref: PropertyRef, refPath: string, literal: SpatialLiteral, positive: boolean): string => {
    const { column, sql } = columnOf(ref, refPath);
    if (op === "s_intersects") return dialect.intersects!(sql, column, literal, param, positive, fn) ?? dialect.never;
    if (op === "s_disjoint") {
      // NOT S_INTERSECTS, the leaf's polarity flipped: the same NULLs, and a prefilter only where it is exact.
      const intersects = dialect.intersects!(sql, column, literal, param, !positive, fn);
      return intersects === undefined ? dialect.never : `NOT (${intersects})`;
    }
    return dialect.relate!(op, sql, column, literal, param, positive, fn) ?? dialect.never;
  };

  /**
   * A spatial relation: a property and a literal (a literal first is the converse relation, so it's written one way),
   * two literals (S_INTERSECTS and S_DISJOINT decided here; the others by the database), or two properties.
   */
  const spatial = (op: SpatialOperator, args: readonly (PropertyRef | SpatialLiteral)[], path: string, positive: boolean): string => {
    const [a, b] = args as [PropertyRef | SpatialLiteral, PropertyRef | SpatialLiteral];
    const isRef = (x: PropertyRef | SpatialLiteral): x is PropertyRef => "property" in x;
    if (isRef(a) && !isRef(b)) return spatialLeaf(op, a, `${path}/args/0`, b, positive);
    if (!isRef(a) && isRef(b)) return spatialLeaf(CONVERSE[op], b, `${path}/args/1`, a, positive);
    if (!isRef(a) && !isRef(b) && (op === "s_intersects" || op === "s_disjoint")) {
      // The package's own engine, which needs no spatialEngine (evaluate's refusal is by class: S_DISJOINT's needs one).
      return intersects(literalParts(a), literalParts(b)) !== (op === "s_disjoint") ? dialect.true : dialect.false;
    }
    const side = (x: PropertyRef | SpatialLiteral, at: string): PairSide => (isRef(x) ? columnOf(x, at) : { literal: x });
    const [sa, sb] = [side(a, `${path}/args/0`), side(b, `${path}/args/1`)];
    if (op === "s_disjoint") {
      const intersects = dialect.spatialPair!("s_intersects", sa, sb, param, fn);
      return intersects === undefined ? dialect.never : `NOT (${intersects})`;
    }
    return dialect.spatialPair!(op, sa, sb, param, fn) ?? dialect.never;
  };

  /** An end of a temporal function's operand: a constant (a literal's day or instant, ±Infinity for ".."), or a property. */
  type TemporalEnd = { readonly value: number; readonly literal?: ScalarLiteral } | { readonly ref: PropertyRef; readonly path: string };
  const isPropertyEnd = (e: TemporalEnd): e is Extract<TemporalEnd, { ref: PropertyRef }> => "ref" in e;
  const endOf = (x: IntervalEnd, open: number, path: string): TemporalEnd =>
    typeof x !== "string" ? { ref: x, path }
      : x === OPEN ? { value: open }
      : x.includes("T") ? { value: instantOf(x)!, literal: { timestamp: x } } // validate has checked both
      : { value: dayNumber(x), literal: { date: x } };
  /** An operand's begin and end: an instant is the interval from it to itself (one end, twice). */
  const endsOf = (x: TemporalOperand, path: string): readonly [TemporalEnd, TemporalEnd] => {
    if ("interval" in x) return [endOf(x.interval[0], -Infinity, `${path}/interval/0`), endOf(x.interval[1], Infinity, `${path}/interval/1`)];
    const end: TemporalEnd = "property" in x ? { ref: x, path }
      : "date" in x ? { value: dayNumber(x.date), literal: x } : { value: instantOf(x.timestamp)!, literal: x };
    return [end, end];
  };

  /**
   * A temporal function (Temporal Functions), as `evaluate` decides it: the relation's comparisons of the operands'
   * ends (`RELATIONS`), each end read in a day or an instant view, `'..'` decided here. The kind is a literal's, else
   * what the columns' queryables say, else the values' own: the relation in each kind, COALESCE (a value has one kind,
   * so at most one of them isn't NULL). NULL when an end is NULL or infinite, or an interval begins after it ends:
   * `CASE WHEN <each end a value, each interval begins before it ends> THEN <the relation> END`. Without that CASE
   * when a single property (an instant, or an interval's end with the other '..') is compared with literals: every
   * comparison left then reads it, so its NULL comes through them, and a DATE column keeps its index.
   */
  const temporal = (f: TemporalPredicate, path: string, positive: boolean): string => {
    const ends = [...endsOf(f.args[0], `${path}/args/0`), ...endsOf(f.args[1], `${path}/args/1`)];
    const read = [...new Set(ends.filter(isPropertyEnd))];
    if (read.length === 0) return constant(f);
    const kindOf = (l: ScalarLiteral): Kind => (typeof l === "object" && "date" in l ? "day" : "instant");
    const literals = new Set(ends.flatMap((e) => ("literal" in e && e.literal !== undefined ? [kindOf(e.literal)] : [])));
    const held = new Set(read.flatMap((e) => {
      const h = heldKind(columnOf(e.ref, e.path).column);
      return h === "date" ? ["day" as const] : h === "instant" ? ["instant" as const] : [];
    }));
    const kinds: Kind[] = literals.size > 0 ? [...literals] : held.size > 0 ? [...held] : ["day", "instant"];
    if (literals.size === 0 && held.size > 1) return dialect.never; // queryables of both kinds: never one kind
    const [b1, e1, b2, e2] = ends as [TemporalEnd, TemporalEnd, TemporalEnd, TemporalEnd];
    const at: Readonly<Record<End, TemporalEnd>> = { b1, e1, b2, e2 };
    const intervals = [[b1, e1], [b2, e2]].filter(([b, e]) => b !== e) as [TemporalEnd, TemporalEnd][];
    if (intervals.some(([b, e]) => !isPropertyEnd(b) && !isPropertyEnd(e) && b.value > e.value)) return dialect.never;

    const views = kinds.flatMap((kind) => {
      const vs = read.map((e) => subject(e.ref, kind, e.path));
      return vs.every((v) => v !== undefined) ? [new Map(read.map((e, i) => [e, vs[i]!]))] : [];
    });
    const parts = views.map((view) => {
      let plain = false; // see above: decided below, before any SQL is written
      /** `l op r` of two ends; with `plain`, an infinite value taken as NULL by the comparison itself. */
      const end = (l: TemporalEnd, op: string, r: TemporalEnd): Condition => {
        if (!isPropertyEnd(l) && !isPropertyEnd(r)) return ORDERED[op]!(Math.sign(l.value - r.value) || 0);
        if (!isPropertyEnd(l)) return end(r, MIRROR[op]!, l);
        const v = view.get(l)!;
        if (!isPropertyEnd(r)) {
          if (r.literal === undefined) return ORDERED[op]!(-Math.sign(r.value)); // '..': before or after every value
          const lit = r.literal;
          return () => {
            const c = compare(v, op, valueParam(v, literal(lit).value));
            return plain ? bounded(v, c, positive) : c;
          };
        }
        const w = view.get(r)!;
        return () => dialect.compareViews?.(v, op, w) ?? `${v.pair ?? v.sql} ${op} ${w.pair ?? w.sql}`;
      };
      const relation = any(RELATIONS[f.op].map((group) => {
        const seen = new Set<string>(); // an instant's begin and end are one end: each comparison once
        return all(group.flatMap(([l, op, r]) => {
          const key = `${ends.indexOf(at[l])}${op}${ends.indexOf(at[r])}`;
          return seen.has(key) ? [] : (seen.add(key), [end(at[l], op, at[r])]);
        }));
      }));
      const sql = (c: Condition) => (typeof c === "boolean" ? (c ? dialect.true : dialect.false) : c());
      const checks = intervals.map(([b, e]) => [b, e, end(b, "<=", e)] as const);
      const bounds = all(checks.map(([, , c]) => c));
      plain = read.length === 1 && views.length === 1 && bounds === true && typeof relation !== "boolean";
      if (plain) return sql(relation);
      // An end compared in a check is NULL there; infinity isn't, so a view that can hold it checks `finite`.
      const checked = new Set(checks.flatMap(([b, e, c]) => (typeof c === "boolean" ? [] : [b, e])));
      const guard = all([
        ...read.flatMap((e) => {
          const v = view.get(e)!;
          return v.finite !== undefined ? [() => v.finite!] : checked.has(e) ? [] : [() => `${v.sql} IS NOT NULL`];
        }),
        bounds,
      ]);
      const when = sql(guard); // before the relation: its parameters come first
      return caseWhen(when, sql(relation));
    });
    return parts.length === 0 ? dialect.never : parts.length === 1 ? parts[0]! : coalesce(parts);
  };

  /** `positive`: under an even number of NOTs, where a NULL and FALSE select the same rows (see Dialect.intersects). */
  const write = (f: Cql2Filter, path: string, positive = true): string => {
    if (typeof f === "boolean") return f ? dialect.true : dialect.false;
    switch (f.op) {
      case "and":
      case "or":
        return f.args.map((a, i) => `(${write(a, `${path}/args/${i}`, positive)})`).join(f.op === "and" ? " AND " : " OR ");
      case "not":
        return `NOT (${write(f.args[0], `${path}/args/0`, !positive)})`;
      case "isNull":
        return `${columnOf(f.args[0], `${path}/args/0`).sql} IS NULL`;
      case "like": {
        const [s, pattern] = f.args;
        if (!reads(s)) return constant(f); // a string literal on the left
        const p = unwrap(pattern);
        const text = foldKey(p.inner, p.folds);
        const v = subject(s, "text", `${path}/args/0`);
        if (v === undefined) return dialect.never;
        if (isEmptyString(text)) return emptyString(v, "="); // LIKE '' matches '' only
        return v.like ? v.like(text, param) : dialect.like(v, text, param);
      }
      case "between": {
        const [s, low, high] = f.args as readonly [ArithmeticOperand, ArithmeticOperand, ArithmeticOperand];
        if (reads(s) && typeof low === "number" && typeof high === "number") {
          const v = subject(s, "number", `${path}/args/0`);
          return v === undefined ? dialect.never : `${v.sql} BETWEEN ${valueParam(v, low)} AND ${valueParam(v, high)}`;
        }
        // With a property bound or a literal first: x >= low AND x <= high, in SQL's three-valued logic as in evaluate's.
        if (![s, low, high].some(readsAny)) return constant(f);
        const [p0, p1, p2] = [0, 1, 2].map((i) => `${path}/args/${i}`) as [string, string, string];
        return `(${comparison(s, ">=", low, p0, p1, positive)}) AND (${comparison(s, "<=", high, p0, p2, positive)})`;
      }
      case "s_intersects":
      case "s_disjoint":
      case "s_equals":
      case "s_touches":
      case "s_within":
      case "s_overlaps":
      case "s_crosses":
      case "s_contains":
        return spatial(f.op, f.args, path, positive);
      case "in": {
        const [s, list] = f.args as readonly [ArithmeticOperand, readonly ArithmeticOperand[]];
        if (!reads(s) || list.some((item) => reads(item) || isArithmetic(item))) {
          // With a literal on the left or a property among the items: the OR of the equalities.
          const parts = list.map((item, i) => `(${comparison(s, "=", item, `${path}/args/0`, `${path}/args/1/${i}`, positive)})`);
          return `(${parts.join(" OR ")})`;
        }
        const literals = (list as readonly (ScalarLiteral | FoldedString)[]).map(literal);
        const v = subject(s, viewKind(literals[0]!.kind), `${path}/args/0`);
        if (v === undefined) return dialect.never;
        const items = literals.filter((item) => !isEmptyString(item.value)); // = '' is FALSE for a value, NULL for none
        if (items.length === 0) return emptyString(v, "=");
        const ps = items.map((item) => valueParam(v, item.value));
        return bounded(v, v.compare ? `(${ps.map((p) => compare(v, "=", p)).join(" OR ")})` : `${v.sql} IN (${ps.join(", ")})`, positive);
      }
      default: {
        if (isTemporal(f.op)) return temporal(f as TemporalPredicate, path, positive);
        const [a, b] = f.args as readonly [ArithmeticOperand, ArithmeticOperand];
        return comparison(a, f.op, b, `${path}/args/0`, `${path}/args/1`, positive);
      }
    }
  };

  return { where: write(valid, ""), params };
}
