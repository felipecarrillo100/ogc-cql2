/**
 * `ogc-cql2/sql`: CQL2-JSON → a parameterized SQL `WHERE` clause. It builds text and values only: it never imports a
 * driver or runs a query. The application runs the SQL with its own driver.
 *
 * The rule: the SQL selects exactly the rows `ogc-cql2/evaluate` selects from the values the application serves. The
 * differential tests check that against real databases.
 *
 * Dialect `sqlite` follows GeoPackage (OGC 12-128r19, version 1.4), OGC's standard for data in SQLite:
 * - a column's declared type is one of GeoPackage's (Table 1, Req 5), given here as its queryable: `BOOLEAN` →
 *   `boolean`, `TINYINT` … `INTEGER` → `integer`, `FLOAT` / `DOUBLE` / `REAL` → `number`, `TEXT` → `string`, `DATE` →
 *   `string` + `date`, `DATETIME` → `string` + `date-time`;
 * - BOOLEAN is stored as INTEGER 0 / 1, DATE as TEXT `YYYY-MM-DD`, DATETIME as TEXT `YYYY-MM-DDTHH:MM[:SS.SSS]Z`;
 * - SQLite lets a value of another type into any column, and GeoPackage says readers SHOULD allow for that. So each
 *   comparison reads a **typed view** of the column: a value of another type is NULL there, exactly as `evaluate`
 *   gives NULL for a type mismatch (values are never converted);
 * - text, CASEI, LIKE, dates and instants go through registered functions ({@link sqliteFunctions}) that run
 *   `evaluate`'s own code. SQLite's own LIKE ignores ASCII case, and its `lower()` folds ASCII only.
 *
 * Dialect `postgres`, for PostgreSQL (and PostGIS tables):
 * - columns are statically typed, so a literal that can't match a column's type gives NULL when the SQL is built;
 *   `SqlColumn.sqlType` (the declared PostgreSQL type) picks the column's view;
 * - text compares on `normalize(…, NFC) COLLATE "C"`, which is code point order (the database's own collation sorts
 *   by language rules); dates and instants compare as the exact text the application serves (see
 *   {@link postgresValue}), so a string literal compares as `evaluate` does on the served value;
 * - instants are truncated to milliseconds, as `evaluate`'s;
 * - CASEI, and the reading of dates and instants from text, use the functions {@link postgresFunctions} creates once
 *   in the database: PostgreSQL's `lower()` isn't Unicode case folding.
 *
 * The typed views and functions keep the results exact, at a cost: the database can't use a plain index for those
 * predicates.
 */
import { Cql2Error } from "../core/errors.js";
import type { CaseiProperty, CaseiString, Cql2Filter, PropertyRef, ScalarLiteral } from "../core/types.js";
import { caseFoldingEntries, caseiKey, dayOf, instantOf, likeRegExp, plainKey } from "../evaluate/strings.js";
import { assertValid } from "../validate/index.js";

export type SqlDialect = "sqlite" | "postgres";

/** A table column, as its queryable describes it. Without a `type`, its values' types are checked as they come. */
export interface SqlColumn {
  readonly type?: "string" | "number" | "integer" | "boolean";
  readonly format?: "date" | "date-time";
  /** The column's name in the table, when it isn't the property's name. */
  readonly column?: string;
  /** `postgres`: the declared type (`text`, `integer`, `timestamp with time zone`…); else derived from `type`. */
  readonly sqlType?: string;
}

export interface SqlOptions {
  readonly dialect: SqlDialect;
  /** The properties a filter may use, and their columns: the table's queryables. */
  readonly columns: Readonly<Record<string, SqlColumn>>;
  /** `postgres`: the schema of the `cql2_*` functions (see {@link postgresFunctions}), when not on the search path. */
  readonly functionSchema?: string;
}

export interface SqlWhere {
  /** The condition, for `WHERE …`. Values are placeholders: `?` (`sqlite`), `$1`, `$2` … (`postgres`). */
  readonly where: string;
  /** The values, in placeholder order. */
  readonly params: readonly (string | number | boolean)[];
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
  /** A `YYYY-MM-DD` text value that exists. */
  cql2_day: (value) => dayOf(value) ?? null,
  /** An ISO 8601 date-time with `Z` or an offset that exists, as epoch milliseconds. */
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

/** The type of value a literal needs, and so the view of the column it is compared with. */
type Kind = "text" | "casei" | "number" | "boolean" | "day" | "instant";

/** A column read as one kind of value: the SQL expression, and the cast its parameters need (`postgres`). */
interface View {
  readonly sql: string;
  readonly cast: string;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

// --- sqlite ----------------------------------------------------------------------------------------------------------

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

// --- postgres --------------------------------------------------------------------------------------------------------

type PgClass = "text" | "number" | "boolean" | "date" | "timestamptz" | "timestamp" | "other";

/** What a PostgreSQL column holds, from its declared type, or else from its queryable. */
function pgClass(column: SqlColumn): PgClass {
  if (column.sqlType !== undefined) {
    // Type modifiers can sit anywhere: "character varying(10)", "timestamp(3) with time zone".
    const t = column.sqlType.toLowerCase().replace(/\(\s*\d+\s*(?:,\s*\d+\s*)?\)/g, "").replace(/\s+/g, " ").trim();
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
  if (column.type === "string") return column.format === "date" ? "date" : column.format === "date-time" ? "timestamptz" : "text";
  if (column.type === "integer" || column.type === "number") return "number";
  if (column.type === "boolean") return "boolean";
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

/** PostgreSQL's LIKE refuses a pattern ending in a lone escape; CQL2 (and `evaluate`) read it as a backslash. */
function pgPattern(pattern: string): string {
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

// --- toSql ----------------------------------------------------------------------------------------------------------

/**
 * Builds the `WHERE` condition and its values.
 *
 * @throws Cql2Error `invalid-filter` for a value that isn't a valid filter in the profile.
 * @throws Cql2Error `unknown-property` for a property not in `options.columns`.
 */
export function toSql(filter: Cql2Filter, options: SqlOptions): SqlWhere {
  const valid = assertValid(filter);
  const pg = options.dialect === "postgres";
  const params: (string | number | boolean)[] = [];
  const param = (value: string | number | boolean, cast = ""): string => {
    params.push(value);
    return pg ? `$${params.length}${cast}` : "?";
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
  const view = (sql: string, kind: Kind, column: SqlColumn): View | undefined =>
    pg ? postgresView(sql, kind, column, fn) : sqliteView(sql, kind, column);

  /** The subject (a property, or CASEI of one) read as `kind`; `undefined` when no value can be of that kind. */
  const subject = (x: PropertyRef | CaseiProperty, kind: Kind, path: string): View | undefined => {
    if ("property" in x) {
      const { column, sql } = columnOf(x, path);
      return view(sql, kind, column);
    }
    const { column, sql } = columnOf(x.args[0], `${path}/args/0`);
    return view(sql, "casei", column); // validate allows CASEI(property) only against strings
  };

  /** A literal's kind and its SQL value, keyed exactly as `evaluate` keys it. */
  const literal = (x: ScalarLiteral | CaseiString): { kind: Kind; value: string | number | boolean } => {
    if (typeof x === "string") return { kind: "text", value: plainKey(x) };
    if (typeof x === "number") return { kind: "number", value: x };
    if (typeof x === "boolean") return { kind: "boolean", value: pg ? x : x ? 1 : 0 };
    if ("op" in x) return { kind: "casei", value: caseiKey(x.args[0]) };
    if ("date" in x) return { kind: "day", value: x.date };
    const ms = instantOf(x.timestamp)!; // validate has checked it is one
    return { kind: "instant", value: pg ? new Date(ms).toISOString() : ms };
  };

  // No value can match: NULL, typed so that it fits wherever SQL expects a condition.
  const never = pg ? "NULL::boolean" : "NULL";

  // A CASEI literal compares text: the column's text view, or its CASEI view under CASEI(property).
  const viewKind = (kind: Kind): Kind => (kind === "casei" ? "text" : kind);

  const write = (f: Cql2Filter, path: string): string => {
    if (typeof f === "boolean") return pg ? (f ? "TRUE" : "FALSE") : f ? "1" : "0";
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
        if (v === undefined) return never;
        return pg ? `${v.sql} LIKE ${param(pgPattern(text))}` : `cql2_like(${v.sql}, ${param(text)})`;
      }
      case "between": {
        const [s, low, high] = f.args;
        const v = subject(s, "number", `${path}/args/0`);
        return v === undefined ? never : `${v.sql} BETWEEN ${param(low, v.cast)} AND ${param(high, v.cast)}`;
      }
      case "in": {
        const [s, list] = f.args;
        const items = list.map(literal);
        const v = subject(s, viewKind(items[0]!.kind), `${path}/args/0`);
        return v === undefined ? never : `${v.sql} IN (${items.map((item) => param(item.value, v.cast)).join(", ")})`;
      }
      default: {
        const [s, value] = f.args;
        const lit = literal(value);
        const v = subject(s, viewKind(lit.kind), `${path}/args/0`);
        return v === undefined ? never : `${v.sql} ${f.op} ${param(lit.value, v.cast)}`;
      }
    }
  };

  return { where: write(valid, ""), params };
}
