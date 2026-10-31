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
import type { Cql2Filter, FoldedString, PropertyRef, ScalarLiteral, StringSubject } from "../core/types.js";
import { foldKey, instantOf } from "../evaluate/strings.js";
import { NOT_IN_SQL, refuseUnsupported } from "../core/unsupported.js";
import { CONFORMANCE } from "../core/conformance.js";
import { assertValid, requiredConformance } from "../validate/index.js";
import { duckdb } from "./dialects/duckdb.js";
import { postgres } from "./dialects/postgres.js";
import { sqlite } from "./dialects/sqlite.js";
import { quote, type Dialect, type Kind, type SqlColumn, type SqlOptions, type SqlValue, type SqlWhere, type View } from "./types.js";

export type { SqlColumn, SqlDialect, SqlOptions, SqlValue, SqlWhere } from "./types.js";
export { sqliteFunctions } from "./dialects/sqlite.js";
export { postgresFunctions, postgresValue } from "./dialects/postgres.js";
export { duckdbFunctions, duckdbValue, type DuckdbFunction } from "./dialects/duckdb.js";

const DIALECTS: Readonly<Record<SqlOptions["dialect"], Dialect>> = { sqlite, postgres, duckdb };

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
        const p = unwrap(pattern);
        const text = foldKey(p.inner, p.folds);
        const v = subject(s, "text", `${path}/args/0`);
        if (v === undefined) return dialect.never;
        return v.like ? v.like(text, param) : dialect.like(v, text, param);
      }
      case "between": {
        const [s, low, high] = f.args;
        const v = subject(s, "number", `${path}/args/0`);
        return v === undefined ? dialect.never : `${v.sql} BETWEEN ${valueParam(v, low)} AND ${valueParam(v, high)}`;
      }
      case "s_intersects": {
        const [ref, literal] = f.args;
        const { column, sql } = columnOf(ref, `${path}/args/0`);
        return dialect.intersects!(sql, column, literal, param, positive) ?? dialect.never;
      }
      case "s_disjoint": {
        // NOT S_INTERSECTS, the leaf's polarity flipped: the same NULLs, and a prefilter only where it is exact.
        const [ref, literal] = f.args;
        const { column, sql } = columnOf(ref, `${path}/args/0`);
        const intersects = dialect.intersects!(sql, column, literal, param, !positive);
        return intersects === undefined ? dialect.never : `NOT (${intersects})`;
      }
      case "s_equals":
      case "s_touches":
      case "s_within":
      case "s_overlaps":
      case "s_crosses":
      case "s_contains": {
        const [ref, literal] = f.args;
        const { column, sql } = columnOf(ref, `${path}/args/0`);
        return dialect.relate!(f.op, sql, column, literal, param, positive) ?? dialect.never;
      }
      case "in": {
        const [s, list] = f.args;
        const items = list.map(literal);
        const v = subject(s, viewKind(items[0]!.kind), `${path}/args/0`);
        if (v === undefined) return dialect.never;
        const ps = items.map((item) => valueParam(v, item.value));
        return v.compare ? `(${ps.map((p) => compare(v, "=", p)).join(" OR ")})` : `${v.sql} IN (${ps.join(", ")})`;
      }
      default: {
        const [s, value] = f.args;
        const lit = literal(value);
        const v = subject(s, viewKind(lit.kind), `${path}/args/0`);
        return v === undefined ? dialect.never : compare(v, f.op, valueParam(v, lit.value));
      }
    }
  };

  return { where: write(valid, ""), params };
}
