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
import type { Fold } from "../../core/folds.js";
import { accentMarkEntries, caseFoldingEntries } from "../../evaluate/strings.js";
import type { SpatialLiteral } from "../../core/types.js";
import { quote, type Dialect, type Kind, type SqlColumn, type SqlValue, type View } from "../types.js";

type PgClass = "text" | "number" | "boolean" | "date" | "timestamptz" | "timestamp" | "geometry" | "geography" | "other";

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
  if (column.sqlType === undefined) {
    return typeof column.format === "string" && column.format.startsWith("geometry-") ? "geometry" : queryableClass(column);
  }
  if (/^\s*geometry\b/i.test(column.sqlType)) return "geometry";
  if (/^\s*geography\b/i.test(column.sqlType)) return "geography";
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

function postgresView(sql: string, kind: Kind, column: SqlColumn, fn: (name: string) => string, folds: readonly Fold[]): View | undefined {
  const cls = pgClass(column);
  const text = pgText(sql, cls);
  switch (kind) {
    case "text":
      return text ? { sql: `${text} COLLATE "C"`, cast: "" } : undefined;
    case "fold":
      return text
        ? { sql: `${folds.reduce((expression, fold) => `${fn(`cql2_${fold}`)}(${expression})`, text)} COLLATE "C"`, cast: "" }
        : undefined;
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
 * - `cql2_accent_marks`: the nonspacing marks ACCENTI removes (Unicode 15.0.0, category Mn, except the Japanese voicing
 *   marks), the package's own table;
 * - `cql2_accenti(text)`: a string without accents, as `evaluate` computes it (NFD, the marks removed, NFC);
 * - `cql2_day(text)`: a `YYYY-MM-DD` text that exists, else NULL;
 * - `cql2_instant(text)`: an ISO 8601 date-time with `Z` or an offset that exists, as a timestamptz truncated to
 *   milliseconds, else NULL. The same strict rules as `evaluate`: hours 00–23, minutes and seconds 00–59.
 */
export function postgresFunctions(schema: string): string {
  const s = quote(schema);
  const lit = (text: string): string => `'${text.replaceAll("'", "''")}'`;
  const rows = caseFoldingEntries().map(([from, to]) => `(${lit(String.fromCodePoint(from))}, ${lit(to)})`);
  const marks = accentMarkEntries().map((code) => `(${lit(String.fromCodePoint(code))})`);
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

CREATE TABLE IF NOT EXISTS ${s}.cql2_accent_marks (mark text COLLATE "C" PRIMARY KEY);
TRUNCATE ${s}.cql2_accent_marks;
INSERT INTO ${s}.cql2_accent_marks (mark) VALUES
${marks.join(",\n")};

CREATE OR REPLACE FUNCTION ${s}.cql2_accenti(t text) RETURNS text
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $f$
  SELECT CASE WHEN t ~ '^[\\x01-\\x7F]*$' THEN t
  ELSE (SELECT normalize(coalesce(string_agg(c.ch, '' ORDER BY c.n), ''), NFC)
        FROM regexp_split_to_table(normalize(t, NFD), '') WITH ORDINALITY AS c(ch, n)
        WHERE NOT EXISTS (SELECT 1 FROM ${s}.cql2_accent_marks m WHERE m.mark = c.ch COLLATE "C"))
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

/** A geometry column's SRID: `srid`, else the declared type's (`geometry(Point, 3857)`), else 4326. */
function sridOf(column: SqlColumn): number {
  if (column.srid !== undefined) return column.srid;
  const declared = /\(\s*\w+\s*,\s*(\d+)\s*\)/.exec(column.sqlType ?? "");
  return declared ? Number(declared[1]) : 4326;
}

/**
 * S_INTERSECTS in PostGIS, exactly as `evaluate` (and GEOS) decide it, using the spatial index:
 * `column && literal AND NOT ST_Disjoint(column, literal)`. The bounding-box test `&&` uses the GiST index, and GEOS's
 * `ST_Disjoint` decides exactly. PostGIS's own `ST_Intersects` takes a shortcut for a point in a polygon that isn't
 * exact for a point lying exactly on an edge (measured on PostGIS 3.5.6), so it isn't used. A column in another SRID
 * is transformed to 4326 (planar in CRS84, as CQL2 compares; a planar comparison in Mercator would draw other edges),
 * which can't use a plain index on the column. Heights are ignored (GEOS's predicates are 2D).
 */
function postgresIntersects(sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string): string | undefined {
  const cls = pgClass(column);
  if (cls !== "geometry" && cls !== "geography") return undefined;
  const srid = cls === "geography" ? 4326 : sridOf(column);
  const g = cls === "geography" ? `${sql}::geometry` : srid === 4326 ? sql : `ST_Transform(${sql}, 4326)`;
  const parts: string[] = [];
  if ("bbox" in literal && !("type" in literal)) {
    const b = literal.bbox;
    const [west, south, east, north] = b.length === 4 ? b : [b[0], b[1], b[3], b[4]];
    const s = param(south);
    const n = param(north);
    const box = (w: string, e: string) => `ST_MakeEnvelope(${w}::double precision, ${s}::double precision, ${e}::double precision, ${n}::double precision, 4326)`;
    if (west > east) parts.push(box(param(west), "180"), box("-180", param(east))); // across the antimeridian: two boxes
    else parts.push(box(param(west), param(east)));
  } else {
    parts.push(`ST_SetSRID(ST_GeomFromGeoJSON(${param(JSON.stringify(literal))}), 4326)`);
  }
  const tests = parts.map((l) => `(${g} && ${l} AND NOT ST_Disjoint(${g}, ${l}))`);
  return tests.length === 1 ? tests[0]! : `(${tests.join(" OR ")})`;
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
  intersects: postgresIntersects,
};
