/**
 * `ogc-cql2/sql`: CQL2-JSON → a parameterized SQL `WHERE` clause. It builds text and values only: it never imports a
 * driver or runs a query. The application runs the SQL with its own driver.
 *
 * The rule: the SQL selects exactly the rows `ogc-cql2/evaluate` selects from the same values. The differential tests
 * check that against a real database.
 *
 * Dialect `sqlite` follows GeoPackage (OGC 12-128r19, version 1.4), OGC's standard for data in SQLite:
 * - a column's declared type is one of GeoPackage's (Table 1, Req 5), given here as its queryable: `BOOLEAN` →
 *   `boolean`, `TINYINT` … `INTEGER` → `integer`, `FLOAT` / `DOUBLE` / `REAL` → `number`, `TEXT` → `string`, `DATE` →
 *   `string` + `date`, `DATETIME` → `string` + `date-time`;
 * - BOOLEAN is stored as INTEGER 0 / 1, DATE as TEXT `YYYY-MM-DD`, DATETIME as TEXT `YYYY-MM-DDTHH:MM[:SS.SSS]Z`;
 * - SQLite lets a value of another type into any column, and GeoPackage says readers SHOULD allow for that. So each
 *   comparison reads a **typed view** of the column: a value of another type is NULL there, exactly as `evaluate`
 *   gives NULL for a type mismatch (values are never converted);
 * - text, CASEI, LIKE and instants go through registered functions ({@link sqliteFunctions}) that run `evaluate`'s
 *   own code: NFC normalization, Unicode full case folding, case-sensitive LIKE, ISO 8601 instants with an offset.
 *   SQLite's own LIKE ignores ASCII case, and its `lower()` folds ASCII only.
 *
 * The typed views and functions keep the results exact, at a cost: SQLite can't use an index for those predicates.
 */
import { Cql2Error } from "../core/errors.js";
import type { CaseiProperty, CaseiString, Cql2Filter, PropertyRef, ScalarLiteral } from "../core/types.js";
import { caseiKey, dayOf, instantOf, likeRegExp, plainKey } from "../evaluate/strings.js";
import { assertValid } from "../validate/index.js";

export type SqlDialect = "sqlite";

/** A table column, as its queryable describes it. Without a `type`, its values' types are checked as they come. */
export interface SqlColumn {
  readonly type?: "string" | "number" | "integer" | "boolean";
  readonly format?: "date" | "date-time";
  /** The column's name in the table, when it isn't the property's name. */
  readonly column?: string;
}

export interface SqlOptions {
  readonly dialect: SqlDialect;
  /** The properties a filter may use, and their columns: the table's queryables. */
  readonly columns: Readonly<Record<string, SqlColumn>>;
}

export interface SqlWhere {
  /** The condition, for `WHERE …`. Values are `?` placeholders. */
  readonly where: string;
  /** The values, in placeholder order. */
  readonly params: readonly (string | number)[];
}

const likeCache = new Map<string, RegExp>();

/**
 * The SQL functions the `sqlite` dialect calls. Register each on the connection before running the SQL, e.g. with
 * `node:sqlite`: `for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn)`.
 * Each returns NULL for a NULL value, or for a value of another type.
 */
export const sqliteFunctions: {
  readonly cql2_text: (value: unknown) => string | null;
  readonly cql2_casei: (value: unknown) => string | null;
  readonly cql2_day: (value: unknown) => string | null;
  readonly cql2_instant: (value: unknown) => number | null;
  readonly cql2_like: (value: unknown, pattern: unknown) => number | null;
} = {
  /** A text value, NFC-normalized. */
  cql2_text: (value) => (typeof value === "string" ? plainKey(value) : null),
  /** A text value, case-folded (CASEI). */
  cql2_casei: (value) => (typeof value === "string" ? caseiKey(value) : null),
  /** A `YYYY-MM-DD` text value. */
  cql2_day: (value) => dayOf(value) ?? null,
  /** An ISO 8601 date-time with `Z` or an offset, as epoch milliseconds. */
  cql2_instant: (value) => instantOf(value) ?? null,
  /** 1 or 0: does the value match the LIKE pattern (already normalized or folded)? */
  cql2_like: (value, pattern) => {
    if (typeof value !== "string" || typeof pattern !== "string") return null;
    let re = likeCache.get(pattern);
    if (!re) {
      re = likeRegExp(pattern);
      if (likeCache.size > 1000) likeCache.clear();
      likeCache.set(pattern, re);
    }
    return re.test(value) ? 1 : 0;
  },
};

/** The type of value a literal needs, and so the typed view of the column it is compared with. */
type Kind = "text" | "casei" | "number" | "boolean" | "day" | "instant";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The SQL expression reading the column as values of this kind: anything else is NULL there. Checked on each value,
 * not from the declared type, since any column may hold a value of another type. One exception: SQLite stores no
 * booleans, so only a column declared BOOLEAN has them, as GeoPackage's 0 / 1, which are then not numbers (the
 * application reads them as `false` / `true`). `undefined`: no value can ever be of that kind.
 */
function view(sqlColumn: string, kind: Kind, column: SqlColumn): string | undefined {
  const numeric = `typeof(${sqlColumn}) IN ('integer', 'real')`;
  switch (kind) {
    case "text":
      return `cql2_text(${sqlColumn})`;
    case "casei":
      return `cql2_casei(${sqlColumn})`;
    case "day":
      return `cql2_day(${sqlColumn})`;
    case "instant":
      return `cql2_instant(${sqlColumn})`;
    case "number":
      return column.type === "boolean"
        ? `(CASE WHEN ${numeric} AND ${sqlColumn} NOT IN (0, 1) THEN ${sqlColumn} END)`
        : `(CASE WHEN ${numeric} THEN ${sqlColumn} END)`;
    case "boolean":
      return column.type === "boolean" ? `(CASE WHEN ${numeric} AND ${sqlColumn} IN (0, 1) THEN ${sqlColumn} END)` : undefined;
  }
}

/**
 * Builds the `WHERE` condition and its values.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 * @throws Cql2Error `unknown-property` for a property not in `options.columns`.
 */
export function toSql(filter: Cql2Filter, options: SqlOptions): SqlWhere {
  const valid = assertValid(filter);
  const params: (string | number)[] = [];
  const param = (value: string | number): string => {
    params.push(value);
    return "?";
  };

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
  const subject = (x: PropertyRef | CaseiProperty, kind: Kind, path: string): string | undefined => {
    if ("property" in x) {
      const { column, sql } = columnOf(x, path);
      return view(sql, kind, column);
    }
    const { column, sql } = columnOf(x.args[0], `${path}/args/0`);
    return view(sql, "casei", column); // validate allows CASEI(property) only against strings
  };

  /** A literal's kind and its SQL value, keyed exactly as `evaluate` keys it. */
  const literal = (x: ScalarLiteral | CaseiString): { kind: Kind; value: string | number } => {
    if (typeof x === "string") return { kind: "text", value: plainKey(x) };
    if (typeof x === "number") return { kind: "number", value: x };
    if (typeof x === "boolean") return { kind: "boolean", value: x ? 1 : 0 };
    if ("op" in x) return { kind: "casei", value: caseiKey(x.args[0]) };
    if ("date" in x) return { kind: "day", value: x.date };
    return { kind: "instant", value: Date.parse(x.timestamp) };
  };

  // A CASEI literal compares text: the column's text view, or its CASEI view under CASEI(property).
  const viewKind = (kind: Kind): Kind => (kind === "casei" ? "text" : kind);

  const write = (f: Cql2Filter, path: string): string => {
    if (typeof f === "boolean") return f ? "1" : "0";
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
        return v === undefined ? "NULL" : `cql2_like(${v}, ${param(text)})`;
      }
      case "between": {
        const [s, low, high] = f.args;
        const v = subject(s, "number", `${path}/args/0`);
        return v === undefined ? "NULL" : `${v} BETWEEN ${param(low)} AND ${param(high)}`;
      }
      case "in": {
        const [s, list] = f.args;
        const items = list.map(literal);
        const v = subject(s, viewKind(items[0]!.kind), `${path}/args/0`);
        return v === undefined ? "NULL" : `${v} IN (${items.map((item) => param(item.value)).join(", ")})`;
      }
      default: {
        const [s, value] = f.args;
        const lit = literal(value);
        const v = subject(s, viewKind(lit.kind), `${path}/args/0`);
        return v === undefined ? "NULL" : `${v} ${f.op} ${param(lit.value)}`;
      }
    }
  };

  return { where: write(valid, ""), params };
}
