/**
 * Dialect `sqlite`, following GeoPackage (OGC 12-128r19, version 1.4), OGC's standard for data in SQLite:
 * - a column's declared type is one of GeoPackage's (Table 1, Req 5), given here as its queryable: `BOOLEAN` →
 *   `boolean`, `TINYINT` … `INTEGER` → `integer`, `FLOAT` / `DOUBLE` / `REAL` → `number`, `TEXT` → `string`, `DATE` →
 *   `string` + `date`, `DATETIME` → `string` + `date-time`;
 * - BOOLEAN is stored as INTEGER 0 / 1, DATE as TEXT `YYYY-MM-DD`, DATETIME as TEXT `YYYY-MM-DDTHH:MM[:SS.SSS]Z`;
 * - SQLite lets a value of another type into any column, and GeoPackage says readers SHOULD allow for that. So each
 *   comparison reads a **typed view** of the column: a value of another type is NULL there, exactly as `evaluate`
 *   gives NULL for a type mismatch (values are never converted);
 * - text, CASEI, LIKE, dates and instants go through registered functions ({@link sqliteFunctions}) that run
 *   `evaluate`'s own code. SQLite's own LIKE ignores ASCII case, and its `lower()` folds ASCII only.
 */
import { caseiKey, dayOf, instantOf, likeRegExp, plainKey } from "../../evaluate/strings.js";
import type { Dialect, Kind, SqlColumn, View } from "../types.js";

const likeCache = new Map<string, RegExp>();

/** A LIKE pattern's regular expression, cached: the same pattern is tested on every row. */
export function cachedLike(pattern: string): RegExp {
  let re = likeCache.get(pattern);
  if (!re) {
    re = likeRegExp(pattern);
    if (likeCache.size > 1000) likeCache.clear();
    likeCache.set(pattern, re);
  }
  return re;
}

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
  /** A `YYYY-MM-DD` text value that exists. */
  cql2_day: (value) => dayOf(value) ?? null,
  /** An ISO 8601 date-time with `Z` or an offset that exists, as epoch milliseconds. */
  cql2_instant: (value) => instantOf(value) ?? null,
  /** 1 or 0: does the value match the LIKE pattern (already normalized or folded)? */
  cql2_like: (value, pattern) => {
    if (typeof value !== "string" || typeof pattern !== "string") return null;
    return cachedLike(pattern).test(value) ? 1 : 0;
  },
};

/**
 * A column read as values of this kind: anything else is NULL there. Checked on each value, not from the declared
 * type, since any column may hold a value of another type. One exception: SQLite stores no booleans, so only a column
 * declared BOOLEAN has them, as GeoPackage's 0 / 1, which are then not numbers (the application reads them as
 * `false` / `true`). `undefined`: no value can ever be of that kind.
 */
function sqliteView(sql: string, kind: Kind, column: SqlColumn): View | undefined {
  const numeric = `typeof(${sql}) IN ('integer', 'real')`;
  const view = (expression: string): View => ({ sql: expression, cast: "" });
  switch (kind) {
    case "text":
      return view(`cql2_text(${sql})`);
    case "casei":
      return view(`cql2_casei(${sql})`);
    case "day":
      return view(`cql2_day(${sql})`);
    case "instant":
      return view(`cql2_instant(${sql})`);
    case "number":
      return view(
        column.type === "boolean"
          ? `(CASE WHEN ${numeric} AND ${sql} NOT IN (0, 1) THEN ${sql} END)`
          : `(CASE WHEN ${numeric} THEN ${sql} END)`,
      );
    case "boolean":
      return column.type === "boolean" ? view(`(CASE WHEN ${numeric} AND ${sql} IN (0, 1) THEN ${sql} END)`) : undefined;
  }
}

export const sqlite: Dialect = {
  placeholder: () => "?",
  true: "1",
  false: "0",
  never: "NULL",
  boolean: (value) => (value ? 1 : 0),
  instant: (ms) => ms,
  view: sqliteView,
  like: (v, pattern, param) => `cql2_like(${v.sql}, ${param(pattern)})`,
};
