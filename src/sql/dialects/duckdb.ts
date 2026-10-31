/**
 * Dialect `duckdb`, for DuckDB: the same SQL in Node (`@duckdb/node-api`) and in the browser (`@duckdb/duckdb-wasm`),
 * on its tables or straight on files (GeoParquet, Parquet, CSV…).
 * - columns are statically typed, as in `postgres`: `SqlColumn.sqlType` (the type `DESCRIBE` gives) picks the
 *   column's view, and a literal that can't match the column's type gives NULL when the SQL is built;
 * - text compares on `nfc_normalize(…) COLLATE "binary"`: code point order, whatever the database's
 *   `default_collation`; dates and timestamps compare as the exact text the application serves (see
 *   {@link duckdbValue});
 * - LIKE is DuckDB's own (case-sensitive, `_` one code point) with `ESCAPE '\'`;
 * - instants compare as epoch milliseconds, truncated as `evaluate`'s, so nothing depends on the time-zone setting;
 * - CASEI, and dates and instants read from text, call the functions {@link duckdbFunctions} registers on the
 *   connection. They all return 32-bit integers, the one result type DuckDB-WASM (1.32.0) passes back exactly from a
 *   JavaScript function: text comes back as zero bytes, DOUBLE as a 32-bit float, BIGINT cut to 32 bits.
 */
import { caseiKey, compareCodePoints, dayOf, instantOf } from "../../evaluate/strings.js";
import { quote, type Dialect, type Kind, type SqlColumn, type View } from "../types.js";
import { bareType, likePattern, queryableClass } from "./postgres.js";
import { cachedLike } from "./sqlite.js";

type DuckClass = "text" | "number" | "boolean" | "date" | "timestamptz" | "timestamp" | "other";

const TEXT = ["varchar", "char", "bpchar", "text", "string"];
const NUMBER = [
  "tinyint", "int1", "smallint", "int2", "short", "integer", "int4", "int", "signed", "bigint", "int8", "long",
  "hugeint", "int128", "utinyint", "usmallint", "uinteger", "ubigint", "uhugeint",
  "float", "float4", "real", "double", "float8", "decimal", "numeric",
];
const TIMESTAMP = ["timestamp", "datetime", "timestamp without time zone", "timestamp_s", "timestamp_ms", "timestamp_us", "timestamp_ns"];

/** What a DuckDB column holds, from its declared type, or else from its queryable. */
function duckClass(column: SqlColumn): DuckClass {
  if (column.sqlType === undefined) return queryableClass(column);
  const t = bareType(column.sqlType);
  if (TEXT.includes(t)) return "text";
  if (NUMBER.includes(t)) return "number";
  if (t === "boolean" || t === "bool" || t === "logical") return "boolean";
  if (t === "date") return "date";
  if (t === "timestamp with time zone" || t === "timestamptz") return "timestamptz";
  if (TIMESTAMP.includes(t)) return "timestamp";
  return "other"; // lists, structs, BLOB, GEOMETRY, UUID, JSON…
}

/** An instant as epoch milliseconds, truncated (DuckDB's `epoch_ms` rounds). */
const millisecondsOf = (sql: string): string => `floor(epoch_us(${sql}) / 1000)`;

/** The text a column's value is served as, for the classes that are served as strings. */
function servedText(sql: string, cls: DuckClass): string | undefined {
  switch (cls) {
    case "text":
      return sql;
    case "date":
      return `strftime(${sql}, '%Y-%m-%d')`;
    case "timestamptz":
      return `strftime(make_timestamp(CAST(${millisecondsOf(sql)} AS BIGINT) * 1000), '%Y-%m-%dT%H:%M:%S.%gZ')`;
    case "timestamp":
      return `strftime(CAST(${sql} AS TIMESTAMP), '%Y-%m-%dT%H:%M:%S.%g')`; // %g: milliseconds, truncated
    default:
      return undefined;
  }
}

/**
 * The SQL expression to SELECT for a column, so that the application serves exactly the values the `duckdb` dialect
 * compares: dates as `YYYY-MM-DD`, instants as UTC `YYYY-MM-DDTHH:MM:SS.sssZ`, timestamps without a time zone the
 * same without `Z`, numbers as DOUBLE. Text and booleans as they are. `undefined` for a column type the dialect can't
 * compare (lists, structs, BLOB, GEOMETRY…), which an application shouldn't serve as a queryable.
 */
export function duckdbValue(sqlColumn: string, column: SqlColumn): string | undefined {
  const sql = quote(sqlColumn);
  const cls = duckClass(column);
  if (cls === "text" || cls === "boolean") return sql;
  if (cls === "number") return `CAST(${sql} AS DOUBLE)`;
  return servedText(sql, cls);
}

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` day as days since 1970-01-01. */
const dayNumber = (day: string): number => instantOf(`${day}T00:00:00Z`)! / DAY_MS;

function duckdbView(sql: string, kind: Kind, column: SqlColumn): View | undefined {
  const cls = duckClass(column);
  const text = servedText(sql, cls);
  switch (kind) {
    case "text":
      return text ? { sql: `${cls === "text" ? `nfc_normalize(${text})` : text} COLLATE "binary"`, cast: "::VARCHAR" } : undefined;
    case "casei":
      return text
        ? {
            sql: text,
            cast: "::VARCHAR",
            compare: (op, param) => `cql2_casei_cmp(${text}, ${param}) ${op} 0`,
            like: (pattern, param) => `cql2_casei_like(${text}, ${param(pattern)}::VARCHAR) = 1`,
          }
        : undefined;
    case "number":
      return cls === "number" ? { sql: `CAST(${sql} AS DOUBLE)`, cast: "::DOUBLE" } : undefined;
    case "boolean":
      return cls === "boolean" ? { sql, cast: "::BOOLEAN" } : undefined;
    case "day":
      if (cls === "date") return { sql, cast: "::DATE" };
      return cls === "text" ? { sql: `cql2_day(${sql})`, cast: "::INTEGER", value: (day) => dayNumber(day as string) } : undefined;
    case "instant":
      if (cls === "timestamptz") return { sql: millisecondsOf(sql), cast: "::DOUBLE" };
      // Epoch milliseconds don't fit in the functions' 32-bit integers: the UTC day, and the milliseconds into it.
      return cls === "text"
        ? { sql: `(CAST(cql2_instant_day(${sql}) AS BIGINT) * ${DAY_MS} + cql2_instant_ms(${sql}))`, cast: "::BIGINT" }
        : undefined;
  }
}

/** A function the `duckdb` dialect calls, with the types to register it with. */
export interface DuckdbFunction {
  /** DuckDB's types of the arguments. */
  readonly parameters: readonly "VARCHAR"[];
  /** DuckDB's type of the result: INTEGER, 32 bits. */
  readonly returns: "INTEGER";
  /** The function: NULL for a NULL argument. */
  readonly call: (...args: (string | null)[]) => number | null;
}

/**
 * The SQL functions the `duckdb` dialect calls. Register each on the connection before running the SQL, with its
 * types; the README shows how with `@duckdb/node-api` and with `@duckdb/duckdb-wasm`. All of them return 32-bit
 * integers, so that they work the same in both.
 */
export const duckdbFunctions: {
  readonly cql2_casei_cmp: DuckdbFunction;
  readonly cql2_casei_like: DuckdbFunction;
  readonly cql2_day: DuckdbFunction;
  readonly cql2_instant_day: DuckdbFunction;
  readonly cql2_instant_ms: DuckdbFunction;
} = {
  /** CASEI order: the sign of comparing the value's caseless form with a key (already case-folded). */
  cql2_casei_cmp: {
    parameters: ["VARCHAR", "VARCHAR"],
    returns: "INTEGER",
    call: (value, key) => (value === null || key === null ? null : Math.sign(compareCodePoints(caseiKey(value), key))),
  },
  /** 1 or 0: does the value's caseless form match the LIKE pattern (already case-folded)? */
  cql2_casei_like: {
    parameters: ["VARCHAR", "VARCHAR"],
    returns: "INTEGER",
    call: (value, pattern) => (value === null || pattern === null ? null : cachedLike(pattern).test(caseiKey(value)) ? 1 : 0),
  },
  /** A `YYYY-MM-DD` text that exists, as days since 1970-01-01. */
  cql2_day: {
    parameters: ["VARCHAR"],
    returns: "INTEGER",
    call: (value) => {
      const day = dayOf(value);
      return day === undefined ? null : dayNumber(day);
    },
  },
  /** An ISO 8601 date-time with `Z` or an offset that exists: its UTC day, as days since 1970-01-01. */
  cql2_instant_day: {
    parameters: ["VARCHAR"],
    returns: "INTEGER",
    call: (value) => {
      const ms = instantOf(value);
      return ms === undefined ? null : Math.floor(ms / DAY_MS);
    },
  },
  /** The same date-time: the milliseconds into its UTC day. */
  cql2_instant_ms: {
    parameters: ["VARCHAR"],
    returns: "INTEGER",
    call: (value) => {
      const ms = instantOf(value);
      return ms === undefined ? null : ms - Math.floor(ms / DAY_MS) * DAY_MS;
    },
  },
};

export const duckdb: Dialect = {
  placeholder: (n) => `$${n}`,
  true: "TRUE",
  false: "FALSE",
  never: "NULL::BOOLEAN",
  boolean: (value) => value,
  instant: (ms) => ms,
  view: duckdbView,
  like: (v, pattern, param) => `${v.sql} LIKE ${param(likePattern(pattern))} ESCAPE '\\'`,
};
