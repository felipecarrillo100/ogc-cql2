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
 * - `duckdb`, for DuckDB in Node and in the browser: {@link duckdbValue}, {@link duckdbFunctions}.
 *
 * The typed views and functions keep the results exact, at a cost: the database can't use a plain index for those
 * predicates.
 */
import { Cql2Error } from "../core/errors.js";
import { unwrap } from "../core/folds.js";
import { heldKind, type HeldKind } from "../core/queryables.js";
import { CONVERSE } from "../core/relate.js";
import type {
  Cql2Filter, FoldedString, Operand, PropertyRef, ScalarLiteral, SpatialLiteral, SpatialOperator, StringSubject,
} from "../core/types.js";
import { toEvaluator } from "../evaluate/index.js";
import { intersects, literalParts } from "../evaluate/spatial.js";
import { foldKey, instantOf } from "../evaluate/strings.js";
import { NOT_IN_SQL, refuseUnsupported } from "../core/unsupported.js";
import { CONFORMANCE } from "../core/conformance.js";
import { assertValid, requiredConformance } from "../validate/index.js";
import { duckdb } from "./dialects/duckdb.js";
import { postgres } from "./dialects/postgres.js";
import { sqlite } from "./dialects/sqlite.js";
import {
  quote, type Dialect, type Kind, type PairSide, type SqlColumn, type SqlOptions, type SqlValue, type SqlWhere, type View,
} from "./types.js";

export type { SqlColumn, SqlDialect, SqlOptions, SqlValue, SqlWhere } from "./types.js";
export { sqliteFunctions } from "./dialects/sqlite.js";
export { postgresFunctions, postgresValue } from "./dialects/postgres.js";
export { duckdbFunctions, duckdbValue, type DuckdbFunction } from "./dialects/duckdb.js";

const DIALECTS: Readonly<Record<SqlOptions["dialect"], Dialect>> = { sqlite, postgres, duckdb };

/** `a op b` is `b MIRROR[op] a`. */
const MIRROR: Readonly<Record<string, string>> = { "=": "=", "<>": "<>", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };

/** What two properties compared with each other can hold, when their queryables say. */
const COMPARABLE: ReadonlySet<HeldKind> = new Set(["text", "number", "boolean", "date", "instant"]);

/** A side that reads the table: a property, or CASEI / ACCENTI of one (not of a string). */
const reads = (x: Operand): x is StringSubject =>
  typeof x === "object" && ("property" in x || ("op" in x && typeof unwrap(x as FoldedString).inner !== "string"));

/**
 * Builds the `WHERE` condition and its values.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 * @throws Cql2Error `unknown-property` for a property not in `options.columns`.
 * @throws Cql2Error `unsupported` for a spatial class the dialect doesn't evaluate.
 */
export function toSql(filter: Cql2Filter, options: SqlOptions): SqlWhere {
  const valid = assertValid(filter);
  const dialect = DIALECTS[options.dialect];
  // A dialect with spatial SQL evaluates S_INTERSECTS (the two basic classes), and with `relate` Spatial Functions too.
  const relate = options.dialect === "sqlite" && options.spatialite !== true ? undefined : dialect.relate;
  const notEvaluated = relate ? [] : dialect.intersects ? [CONFORMANCE.spatial] : NOT_IN_SQL;
  refuseUnsupported(requiredConformance(valid), notEvaluated, `ogc-cql2/sql (${options.dialect})`);
  const params: SqlValue[] = [];
  const param = (value: SqlValue, cast = ""): string => {
    params.push(value);
    return `${dialect.placeholder(params.length)}${cast}`;
  };
  const fn = (name: string): string => (options.functionSchema ? `${quote(options.functionSchema)}.${name}` : name);

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

  /** A literal's value as a parameter of the view. */
  const valueParam = (v: View, value: SqlValue): string => param(v.value ? v.value(value) : value, v.cast);
  const compare = (v: View, op: string, p: string): string => (v.compare ? v.compare(op, p) : `${v.sql} ${op} ${p}`);

  // A folded literal compares text: the column's text view, or its folded view under CASEI / ACCENTI (property).
  const viewKind = (kind: Kind): Kind => (kind === "fold" ? "text" : kind);

  /** A filter of literals only (Property-Property Comparisons): decided here, exactly as `evaluate` decides it. */
  const constant = (f: Cql2Filter): string => (toEvaluator(f)(undefined) === true ? dialect.true : dialect.false);

  /**
   * `a op b`, each side a property (or CASEI / ACCENTI of one) or a literal. A literal on the left is the property on
   * the left with the operator mirrored, so a property against a literal is always written one way.
   */
  const comparison = (a: Operand, op: string, b: Operand, pathA: string, pathB: string): string => {
    if (!reads(a) && !reads(b)) return constant({ op, args: [a, b] } as Cql2Filter);
    if (!reads(a)) return comparison(b, MIRROR[op]!, a, pathB, pathA);
    if (!reads(b)) {
      const lit = literal(b);
      const v = subject(a, viewKind(lit.kind), pathA);
      return v === undefined ? dialect.never : compare(v, op, valueParam(v, lit.value));
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
    return parts.length === 0 ? dialect.never : parts.length === 1 ? parts[0]! : `COALESCE(${parts.join(", ")})`;
  };

  /** `op(property, literal)`, the property at `refPath`. */
  const spatialLeaf = (op: SpatialOperator, ref: PropertyRef, refPath: string, literal: SpatialLiteral, positive: boolean): string => {
    const { column, sql } = columnOf(ref, refPath);
    if (op === "s_intersects") return dialect.intersects!(sql, column, literal, param, positive) ?? dialect.never;
    if (op === "s_disjoint") {
      // NOT S_INTERSECTS, the leaf's polarity flipped: the same NULLs, and a prefilter only where it is exact.
      const intersects = dialect.intersects!(sql, column, literal, param, !positive);
      return intersects === undefined ? dialect.never : `NOT (${intersects})`;
    }
    return dialect.relate!(op, sql, column, literal, param, positive) ?? dialect.never;
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
      const intersects = dialect.spatialPair!("s_intersects", sa, sb, param);
      return intersects === undefined ? dialect.never : `NOT (${intersects})`;
    }
    return dialect.spatialPair!(op, sa, sb, param) ?? dialect.never;
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
        return v.like ? v.like(text, param) : dialect.like(v, text, param);
      }
      case "between": {
        const [s, low, high] = f.args;
        if (reads(s) && typeof low === "number" && typeof high === "number") {
          const v = subject(s, "number", `${path}/args/0`);
          return v === undefined ? dialect.never : `${v.sql} BETWEEN ${valueParam(v, low)} AND ${valueParam(v, high)}`;
        }
        // With a property bound or a literal first: x >= low AND x <= high, in SQL's three-valued logic as in evaluate's.
        if (!reads(s) && !reads(low) && !reads(high)) return constant(f);
        const [p0, p1, p2] = [0, 1, 2].map((i) => `${path}/args/${i}`) as [string, string, string];
        return `(${comparison(s, ">=", low, p0, p1)}) AND (${comparison(s, "<=", high, p0, p2)})`;
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
        const [s, list] = f.args;
        if (!reads(s) || list.some(reads)) {
          // With a literal on the left or a property among the items: the OR of the equalities.
          const parts = list.map((item, i) => `(${comparison(s, "=", item, `${path}/args/0`, `${path}/args/1/${i}`)})`);
          return `(${parts.join(" OR ")})`;
        }
        const items = (list as readonly (ScalarLiteral | FoldedString)[]).map(literal);
        const v = subject(s, viewKind(items[0]!.kind), `${path}/args/0`);
        if (v === undefined) return dialect.never;
        const ps = items.map((item) => valueParam(v, item.value));
        return v.compare ? `(${ps.map((p) => compare(v, "=", p)).join(" OR ")})` : `${v.sql} IN (${ps.join(", ")})`;
      }
      default:
        return comparison(f.args[0], f.op, f.args[1], `${path}/args/0`, `${path}/args/1`);
    }
  };

  return { where: write(valid, ""), params };
}
