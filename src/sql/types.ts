/**
 * The public types of `ogc-cql2/sql`, and the interface each dialect implements (`dialects/*.ts`): what differs per
 * database, so that `toSql` keeps one walker for all of them.
 */

export type SqlDialect = "sqlite" | "postgres" | "duckdb";

/** A table column, as its queryable describes it. Without a `type`, its values' types are checked as they come. */
export interface SqlColumn {
  readonly type?: "string" | "number" | "integer" | "boolean";
  readonly format?: "date" | "date-time";
  /** The column's name in the table, when it isn't the property's name. */
  readonly column?: string;
  /**
   * `postgres` and `duckdb`: the declared type (`text`, `integer`, `timestamp with time zone`…; `VARCHAR`, `BIGINT`,
   * `TIMESTAMP WITH TIME ZONE`…); else derived from `type`.
   */
  readonly sqlType?: string;
}

export interface SqlOptions {
  readonly dialect: SqlDialect;
  /** The properties a filter may use, and their columns: the table's queryables. */
  readonly columns: Readonly<Record<string, SqlColumn>>;
  /** `postgres`: the schema of the `cql2_*` functions (see `postgresFunctions`), when not on the search path. */
  readonly functionSchema?: string;
}

/** A parameter's value. */
export type SqlValue = string | number | boolean;

export interface SqlWhere {
  /** The condition, for `WHERE …`. Values are placeholders: `?` (`sqlite`), `$1`, `$2` … (`postgres`, `duckdb`). */
  readonly where: string;
  /** The values, in placeholder order. */
  readonly params: readonly SqlValue[];
}

// --- The dialect interface (internal) ----------------------------------------------------------------------------

/** The type of value a literal needs, and so the view of the column it is compared with. */
export type Kind = "text" | "casei" | "number" | "boolean" | "day" | "instant";

/** A column read as one kind of value. */
export interface View {
  /** The SQL expression. */
  readonly sql: string;
  /** The cast its parameters need (`postgres`, `duckdb`). */
  readonly cast: string;
  /** The literal's value as this view compares it, when it isn't the literal's own (a day as a number). */
  readonly value?: (value: SqlValue) => SqlValue;
  /** The condition `view op param`, when it isn't `sql op param`. */
  readonly compare?: (op: string, param: string) => string;
  /** The condition `view LIKE pattern`, when it isn't the dialect's. */
  readonly like?: (pattern: string, param: (value: SqlValue) => string) => string;
}

export interface Dialect {
  /** The placeholder of the `n`th parameter, from 1. */
  placeholder(n: number): string;
  readonly true: string;
  readonly false: string;
  /** No value can match: NULL, typed so that it fits wherever SQL expects a condition. */
  readonly never: string;
  /** A boolean literal, as a parameter value. */
  boolean(value: boolean): SqlValue;
  /** An instant literal (epoch milliseconds), as a parameter value. */
  instant(ms: number): SqlValue;
  /** The column read as `kind`; `undefined` when no value can ever be of that kind. */
  view(sql: string, kind: Kind, column: SqlColumn, fn: (name: string) => string): View | undefined;
  /** `view LIKE pattern`, the pattern keyed as `evaluate` keys it; `param` adds a parameter. */
  like(view: View, pattern: string, param: (value: SqlValue) => string): string;
}

export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
