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
import type { CaseiProperty, CaseiString, Cql2Filter, PropertyRef, ScalarLiteral } from "../core/types.js";
import { caseiKey, instantOf, plainKey } from "../evaluate/strings.js";
import { assertValid } from "../validate/index.js";
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
 */
export function toSql(filter: Cql2Filter, options: SqlOptions): SqlWhere {
  const valid = assertValid(filter);
  const dialect = DIALECTS[options.dialect];
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

  /** The subject (a property, or CASEI of one) read as `kind`; `undefined` when no value can be of that kind. */
  const subject = (x: PropertyRef | CaseiProperty, kind: Kind, path: string): View | undefined => {
    if ("property" in x) {
      const { column, sql } = columnOf(x, path);
      return dialect.view(sql, kind, column, fn);
    }
    const { column, sql } = columnOf(x.args[0], `${path}/args/0`);
    return dialect.view(sql, "casei", column, fn); // validate allows CASEI(property) only against strings
  };

  /** A literal's kind and its SQL value, keyed exactly as `evaluate` keys it. */
  const literal = (x: ScalarLiteral | CaseiString): { kind: Kind; value: SqlValue } => {
    if (typeof x === "string") return { kind: "text", value: plainKey(x) };
    if (typeof x === "number") return { kind: "number", value: x };
    if (typeof x === "boolean") return { kind: "boolean", value: dialect.boolean(x) };
    if ("op" in x) return { kind: "casei", value: caseiKey(x.args[0]) };
    if ("date" in x) return { kind: "day", value: x.date };
    return { kind: "instant", value: dialect.instant(instantOf(x.timestamp)!) }; // validate has checked it is one
  };

  /** A literal's value as a parameter of the view. */
  const valueParam = (v: View, value: SqlValue): string => param(v.value ? v.value(value) : value, v.cast);
  const compare = (v: View, op: string, p: string): string => (v.compare ? v.compare(op, p) : `${v.sql} ${op} ${p}`);

  // A CASEI literal compares text: the column's text view, or its CASEI view under CASEI(property).
  const viewKind = (kind: Kind): Kind => (kind === "casei" ? "text" : kind);

  const write = (f: Cql2Filter, path: string): string => {
    if (typeof f === "boolean") return f ? dialect.true : dialect.false;
    switch (f.op) {
      case "and":
      case "or":
        return f.args.map((a, i) => `(${write(a, `${path}/args/${i}`)})`).join(f.op === "and" ? " AND " : " OR ");
      case "not":
        return `NOT (${write(f.args[0], `${path}/args/0`)})`;
      case "isNull":
        return `${columnOf(f.args[0], `${path}/args/0`).sql} IS NULL`;
      case "like": {
        const [s, pattern] = f.args;
        const text = typeof pattern === "string" ? plainKey(pattern) : caseiKey(pattern.args[0]);
        const v = subject(s, "text", `${path}/args/0`);
        if (v === undefined) return dialect.never;
        return v.like ? v.like(text, param) : dialect.like(v, text, param);
      }
      case "between": {
        const [s, low, high] = f.args;
        const v = subject(s, "number", `${path}/args/0`);
        return v === undefined ? dialect.never : `${v.sql} BETWEEN ${valueParam(v, low)} AND ${valueParam(v, high)}`;
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
