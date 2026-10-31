/**
 * Dialect `postgres`, for PostgreSQL (and PostGIS tables):
 * - columns are statically typed, so a literal that can't match a column's type gives NULL when the SQL is built;
 *   `SqlColumn.sqlType` (the declared PostgreSQL type) picks the column's view;
 * - text compares on `normalize(…, NFC) COLLATE "C"`, which is code point order (the database's own collation sorts
 *   by language rules); dates and instants compare as the exact text the application serves (see
 *   {@link postgresValue}), so a string literal compares as `evaluate` does on the served value;
 * - instants are truncated to milliseconds, as `evaluate`'s;
 * - CASEI, and the reading of dates and instants from text, use the functions {@link postgresFunctions} creates once
 *   in the database: PostgreSQL's `lower()` isn't Unicode case folding.
 */
import { caseFoldingEntries } from "../../evaluate/strings.js";
import { quote, type Dialect, type Kind, type SqlColumn, type View } from "../types.js";

type PgClass = "text" | "number" | "boolean" | "date" | "timestamptz" | "timestamp" | "other";

/** A declared type in lower case, without type modifiers, which can sit anywhere: "timestamp(3) with time zone". */
export const bareType = (sqlType: string): string =>
  sqlType.toLowerCase().replace(/\(\s*\d+\s*(?:,\s*\d+\s*)?\)/g, "").replace(/\s+/g, " ").trim();

/** What a column holds, from its queryable, when no declared type is given. */
export function queryableClass(column: SqlColumn): "text" | "number" | "boolean" | "date" | "timestamptz" | "other" {
  if (column.type === "string") return column.format === "date" ? "date" : column.format === "date-time" ? "timestamptz" : "text";
  if (column.type === "integer" || column.type === "number") return "number";
  if (column.type === "boolean") return "boolean";
  return "other";
}

/** What a PostgreSQL column holds, from its declared type, or else from its queryable. */
function pgClass(column: SqlColumn): PgClass {
  if (column.sqlType === undefined) return queryableClass(column);
  const t = bareType(column.sqlType);
  if (t.endsWith("[]")) return "other";
  if (["text", "character varying", "varchar", "character", "char", "bpchar", "name", "citext"].includes(t)) return "text";
  if (["smallint", "int2", "integer", "int", "int4", "bigint", "int8", "real", "float4", "double precision", "float8", "numeric", "decimal"].includes(t)) {
    return "number";
  }
  if (t === "boolean" || t === "bool") return "boolean";
  if (t === "date") return "date";
  if (t === "timestamp with time zone" || t === "timestamptz") return "timestamptz";
  if (t === "timestamp" || t === "timestamp without time zone") return "timestamp";
  return "other";
}

/** The text a PostgreSQL column's value is served as, for the classes that are served as strings. */
function pgText(sql: string, cls: PgClass): string | undefined {
  switch (cls) {
    case "text":
      return `normalize(${sql}::text, NFC)`;
    case "date":
      return `to_char(${sql}, 'YYYY-MM-DD')`;
    case "timestamptz":
      return `to_char(${sql} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case "timestamp":
      return `to_char(${sql}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;
    default:
      return undefined;
  }
}

/**
 * The SQL expression to SELECT for a column, so that the application serves exactly the values the `postgres`
 * dialect compares: dates as `YYYY-MM-DD`, instants as UTC `YYYY-MM-DDTHH:MM:SS.sssZ`, timestamps without a time zone
 * the same without `Z`, numbers as double precision. Text and booleans as they are. `undefined` for a column type the
 * dialect can't compare (json, uuid, arrays…), which an application shouldn't serve as a queryable.
 */
export function postgresValue(sqlColumn: string, column: SqlColumn): string | undefined {
  const sql = quote(sqlColumn);
  const cls = pgClass(column);
  if (cls === "text" || cls === "boolean") return sql;
  if (cls === "number") return `${sql}::double precision`;
  return pgText(sql, cls);
}

function postgresView(sql: string, kind: Kind, column: SqlColumn, fn: (name: string) => string): View | undefined {
  const cls = pgClass(column);
  const text = pgText(sql, cls);
  switch (kind) {
    case "text":
      return text ? { sql: `${text} COLLATE "C"`, cast: "" } : undefined;
    case "casei":
      return text ? { sql: `${fn("cql2_casei")}(${text}) COLLATE "C"`, cast: "" } : undefined;
    case "number":
      return cls === "number" ? { sql: `${sql}::double precision`, cast: "::double precision" } : undefined;
    case "boolean":
      return cls === "boolean" ? { sql, cast: "::boolean" } : undefined;
    case "day":
      if (cls === "date") return { sql, cast: "::date" };
      return cls === "text" ? { sql: `${fn("cql2_day")}(${sql}::text) COLLATE "C"`, cast: "" } : undefined;
    case "instant":
      if (cls === "timestamptz") return { sql: `date_trunc('milliseconds', ${sql})`, cast: "::timestamptz" };
      return cls === "text" ? { sql: `${fn("cql2_instant")}(${sql}::text)`, cast: "::timestamptz" } : undefined;
  }
}

/**
 * PostgreSQL's LIKE (and DuckDB's) refuses a pattern ending in a lone escape; CQL2 (and `evaluate`) read it as a
 * backslash.
 */
export function likePattern(pattern: string): string {
  const trailing = /\\*$/.exec(pattern)![0].length;
  return trailing % 2 === 1 ? `${pattern}\\` : pattern;
}

/**
 * The SQL that creates, in `schema`, what the `postgres` dialect calls: run it once, as a user who may create objects
 * there. No extension is needed. It creates (or replaces):
 * - `cql2_casefold`: Unicode's full case folding (CaseFolding 15.0.0, statuses C and F), the package's own table;
 * - `cql2_casei(text)`: a string's canonical caseless form, as `evaluate` computes it (NFD, fold, NFC);
 * - `cql2_day(text)`: a `YYYY-MM-DD` text that exists, else NULL;
 * - `cql2_instant(text)`: an ISO 8601 date-time with `Z` or an offset that exists, as a timestamptz truncated to
 *   milliseconds, else NULL. The same strict rules as `evaluate`: hours 00–23, minutes and seconds 00–59.
 */
export function postgresFunctions(schema: string): string {
  const s = quote(schema);
  const lit = (text: string): string => `'${text.replaceAll("'", "''")}'`;
  const rows = caseFoldingEntries().map(([from, to]) => `(${lit(String.fromCodePoint(from))}, ${lit(to)})`);
  return `-- ogc-cql2: functions for the postgres dialect of toSql. Safe to run again.
CREATE TABLE IF NOT EXISTS ${s}.cql2_casefold (from_char text COLLATE "C" PRIMARY KEY, to_text text NOT NULL);
TRUNCATE ${s}.cql2_casefold;
INSERT INTO ${s}.cql2_casefold (from_char, to_text) VALUES
${rows.join(",\n")};

CREATE OR REPLACE FUNCTION ${s}.cql2_casei(t text) RETURNS text
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $f$
  SELECT CASE WHEN t ~ '^[\\x01-\\x7F]*$' THEN lower(t COLLATE "C")
  ELSE (SELECT normalize(coalesce(string_agg(coalesce(f.to_text, c.ch), '' ORDER BY c.n), ''), NFC)
        FROM regexp_split_to_table(normalize(t, NFD), '') WITH ORDINALITY AS c(ch, n)
        LEFT JOIN ${s}.cql2_casefold f ON f.from_char = c.ch COLLATE "C")
  END
$f$;

CREATE OR REPLACE FUNCTION ${s}.cql2_day(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $f$
BEGIN
  IF t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR substr(t, 1, 4) = '0000' THEN RETURN NULL; END IF;
  PERFORM make_date(substr(t, 1, 4)::int, substr(t, 6, 2)::int, substr(t, 9, 2)::int);
  RETURN t;
EXCEPTION WHEN others THEN RETURN NULL;
END
$f$;

CREATE OR REPLACE FUNCTION ${s}.cql2_instant(t text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $f$
DECLARE
  m text[] := regexp_match(t, '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\\.([0-9]+))?)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$', 'i');
  off_minutes int;
BEGIN
  IF m IS NULL OR m[1] = '0000' OR m[4]::int > 23 OR m[5]::int > 59 OR coalesce(m[6], '0')::int > 59
     OR coalesce(m[9], '0')::int > 23 OR coalesce(m[10], '0')::int > 59 THEN
    RETURN NULL;
  END IF;
  off_minutes := CASE WHEN m[8] IS NULL THEN 0 ELSE (CASE m[8] WHEN '-' THEN -1 ELSE 1 END) * (m[9]::int * 60 + m[10]::int) END;
  RETURN (make_timestamp(m[1]::int, m[2]::int, m[3]::int, m[4]::int, m[5]::int,
            coalesce(m[6], '0')::int + coalesce(rpad(left(m[7], 3), 3, '0'), '000')::int / 1000.0) AT TIME ZONE 'UTC')
         - off_minutes * interval '1 minute';
EXCEPTION WHEN others THEN RETURN NULL;
END
$f$;
`;
}

export const postgres: Dialect = {
  placeholder: (n) => `$${n}`,
  true: "TRUE",
  false: "FALSE",
  never: "NULL::boolean",
  boolean: (value) => value,
  instant: (ms) => new Date(ms).toISOString(),
  view: postgresView,
  like: (v, pattern, param) => `${v.sql} LIKE ${param(likePattern(pattern))}`,
};
