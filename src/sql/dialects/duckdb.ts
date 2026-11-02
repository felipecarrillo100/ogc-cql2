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
 * - CASEI, ACCENTI, and dates and instants read from text, call the functions {@link duckdbFunctions} registers on the
 *   connection. They all return 32-bit integers, the one result type DuckDB-WASM (1.32.0) passes back exactly from a
 *   JavaScript function: text comes back as zero bytes, DOUBLE as a 32-bit float, BIGINT cut to 32 bits;
 * - S_INTERSECTS needs the spatial extension (`LOAD spatial`, in Node and in DuckDB-WASM): its `ST_Intersects` is
 *   exact (measured against `evaluate`), on a `GEOMETRY` column or on a `BLOB` column of WKB, and GeoParquet's bbox
 *   covering speeds it up (see {@link duckdbIntersects}). No
 *   JavaScript function stands in: DuckDB-WASM (1.32.0) hands a BLOB to one as UTF-8-decoded text, so WKB can't reach
 *   it.
 */
import type { Fold } from "../../core/folds.js";
import type { MatrixRelation } from "../../core/relate.js";
import { literalParts } from "../../evaluate/spatial.js";
import { caseiKey, compareCodePoints, dayOf, foldKey, instantOf } from "../../evaluate/strings.js";
import type { SpatialLiteral } from "../../core/types.js";
import { quote, type Dialect, type PairSide, type Kind, type SqlColumn, type SqlValue, type View } from "../types.js";
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

/** A fold chain as the `folds` argument of `cql2_fold_cmp` / `cql2_fold_like`: `"accenti,casei"`, innermost first. */
const foldsText = (folds: readonly Fold[]): string => `'${folds.join(",")}'`;

/** The folds argument read back; anything else is refused, so the functions never guess. */
function foldsOf(text: string): Fold[] {
  const folds = text.split(",");
  if (folds.some((f) => f !== "casei" && f !== "accenti")) throw new Error(`cql2_fold_*: unknown folds "${text}"`);
  return folds as Fold[];
}

function duckdbView(sql: string, kind: Kind, column: SqlColumn, _fn: (name: string) => string, folds: readonly Fold[]): View | undefined {
  const cls = duckClass(column);
  const text = servedText(sql, cls);
  switch (kind) {
    case "text":
      return text
        ? { sql: `${cls === "text" ? `nfc_normalize(${text})` : text} COLLATE "binary"`, cast: "::VARCHAR", folded: { text, folds: [] } }
        : undefined;
    case "fold":
      if (!text) return undefined;
      // CASEI alone keeps its own functions, so its SQL is unchanged since 0.2.0.
      if (folds.length === 1 && folds[0] === "casei") {
        return {
          sql: text,
          cast: "::VARCHAR",
          folded: { text, folds },
          compare: (op, param) => `cql2_casei_cmp(${text}, ${param}) ${op} 0`,
          like: (pattern, param) => `cql2_casei_like(${text}, ${param(pattern)}::VARCHAR) = 1`,
        };
      }
      return {
        sql: text,
        cast: "::VARCHAR",
        folded: { text, folds },
        compare: (op, param) => `cql2_fold_cmp(${text}, ${param}, ${foldsText(folds)}) ${op} 0`,
        like: (pattern, param) => `cql2_fold_like(${text}, ${param(pattern)}::VARCHAR, ${foldsText(folds)}) = 1`,
      };
    case "number":
      // Bound as text: DuckDB-WASM (1.32.0) binds a number parameter that needs 17 digits one unit off; text is exact.
      return cls === "number" ? { sql: `CAST(${sql} AS DOUBLE)`, cast: "::DOUBLE", value: (n) => String(n) } : undefined;
    case "boolean":
      return cls === "boolean" ? { sql, cast: "::BOOLEAN" } : undefined;
    case "day":
      // Against another column, a date compares as days since 1970-01-01, the form cql2_day gives dates held as text.
      if (cls === "date") return { sql, cast: "::DATE", pair: `(${sql} - DATE '1970-01-01')` };
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
  readonly cql2_fold_cmp: DuckdbFunction;
  readonly cql2_fold_like: DuckdbFunction;
  readonly cql2_compare: DuckdbFunction;
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
  /**
   * The sign of comparing the value, folded (`folds`: `"accenti"`, `"casei,accenti"`…, innermost first), with a key
   * (already folded): CASEI and ACCENTI together or ACCENTI alone.
   */
  cql2_fold_cmp: {
    parameters: ["VARCHAR", "VARCHAR", "VARCHAR"],
    returns: "INTEGER",
    call: (value, key, folds) =>
      value === null || key === null || folds === null ? null : Math.sign(compareCodePoints(foldKey(value, foldsOf(folds)), key)),
  },
  /** 1 or 0: does the value, folded, match the LIKE pattern (already folded)? */
  cql2_fold_like: {
    parameters: ["VARCHAR", "VARCHAR", "VARCHAR"],
    returns: "INTEGER",
    call: (value, pattern, folds) =>
      value === null || pattern === null || folds === null ? null : cachedLike(pattern).test(foldKey(value, foldsOf(folds))) ? 1 : 0,
  },
  /**
   * The sign of comparing two values, each folded as it says (`""`, `"casei"`, `"accenti,casei"`…, innermost first):
   * two properties compared with each other (Property-Property Comparisons) under CASEI or ACCENTI.
   */
  cql2_compare: {
    parameters: ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"],
    returns: "INTEGER",
    call: (a, foldsA, b, foldsB) =>
      a === null || b === null || foldsA === null || foldsB === null
        ? null
        : Math.sign(compareCodePoints(foldKey(a, foldsA === "" ? [] : foldsOf(foldsA)), foldKey(b, foldsB === "" ? [] : foldsOf(foldsB)))),
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

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

/** `x` rounded outward to a 32-bit float: up (`up`) or down, so a `FLOAT` field however rounded still compares true. */
function outward32(x: number, up: boolean): number {
  const r = Math.fround(x);
  if (up ? r >= x : r <= x) return r;
  if (r === 0) return up ? 2 ** -149 : -(2 ** -149);
  f32[0] = r;
  i32[0]! += (r > 0) === up ? 1 : -1;
  return f32[0]!;
}

/**
 * S_INTERSECTS in DuckDB, exactly as `evaluate` decides it, written as DuckDB documents it: `ST_Intersects(column,
 * literal)`, which uses an R-tree index and (DuckDB 1.5+) the row groups' statistics, with the literal a constant
 * (`ST_MakeEnvelope`, or `ST_GeomFromGeoJSON` of a parameter). Its `ST_Intersects` is exact, unlike PostGIS's (0 of
 * 5,705 literals differ from `evaluate`, in DuckDB 1.4.3, as in DuckDB-WASM 1.32.0, and 2.0).
 * - A `GEOMETRY` column (also a column given only as a geometry queryable), or a `BLOB` column of WKB read with
 *   `TRY(ST_GeomFromWKB(column))`, so bytes that aren't WKB are NULL, as in `evaluate`.
 * - A box across the antimeridian is one literal, the union of its two halves: an OR of two tests loses the index.
 * - With `column.covering` (GeoParquet's bbox covering), outside a NOT: the four comparisons on the covering's fields
 *   first, which skip Parquet row groups and most rows before the exact test; DuckDB doesn't use a covering by
 *   itself. The literal's box is rounded outward to 32-bit floats, as GeoParquet allows `FLOAT` fields. Under a NOT
 *   the exact test alone decides, as a row without a geometry has no box (NULL, not FALSE).
 * `undefined` for a column that isn't a geometry.
 */
function duckdbIntersects(sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean): string | undefined {
  return spatial(sql, column, literal, param, positive, (g, l) => `ST_Intersects(${g}, ${l})`);
}

/**
 * The other relations of Spatial Functions (S_DISJOINT is NOT S_INTERSECTS), as `ST_Equals`, `ST_Touches`,
 * `ST_Within`, `ST_Overlaps`, `ST_Crosses`, `ST_Contains`: exact against GEOS's DE-9IM matrix on DuckDB 1.4.3, 1.5.4
 * and 2.0 (measured; DuckDB has no `ST_Relate`), each using an R-tree index. The column, the literal and the covering
 * as for S_INTERSECTS: each of these relations needs the two boxes to meet, so the covering's overlap test is a
 * necessary condition for all of them.
 */
function duckdbRelate(relation: MatrixRelation, sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean): string | undefined {
  return spatial(sql, column, literal, param, positive, (g, l) => `${ST[relation]}(${g}, ${l})`);
}

const ST = { s_intersects: "ST_Intersects", s_equals: "ST_Equals", s_touches: "ST_Touches", s_within: "ST_Within", s_overlaps: "ST_Overlaps", s_crosses: "ST_Crosses", s_contains: "ST_Contains" } as const;

/** A column as a geometry: a GEOMETRY column as it is, WKB in a BLOB read with TRY(…); `undefined` for neither. */
function columnGeometry(sql: string, column: SqlColumn): string | undefined {
  const t = column.sqlType === undefined ? undefined : bareType(column.sqlType);
  const geometry = t === undefined ? typeof column.format === "string" && column.format.startsWith("geometry-") : /^geometry\b/.test(t);
  const wkb = ["blob", "bytea", "binary", "varbinary"].includes(t ?? "");
  return geometry ? sql : wkb ? `TRY(ST_GeomFromWKB(${sql}))` : undefined;
}

/** A literal as a geometry, a parameter: a box as an envelope (across the antimeridian the union of two), its boxes. */
function literalGeometrySql(literal: SpatialLiteral, param: (value: SqlValue) => string): { readonly l: string; readonly boxes: number[][] | undefined } {
  const number = (x: number) => `${param(String(x))}::DOUBLE`; // as text, as the number views bind it
  const envelope = (w: number, s: number, e: number, n: number) => `ST_MakeEnvelope(${number(w)}, ${number(s)}, ${number(e)}, ${number(n)})`;
  if ("bbox" in literal && !("type" in literal)) {
    const b = literal.bbox;
    const [west, south, east, north] = b.length === 4 ? b : [b[0], b[1], b[3], b[4]];
    const boxes = west > east ? [[west, south, 180, north], [-180, south, east, north]] : [[west, south, east, north]];
    return { l: boxes.length === 1 ? envelope(west, south, east, north) : `ST_Union(${envelope(west, south, 180, north)}, ${envelope(-180, south, east, north)})`, boxes };
  }
  const box = literalParts(literal).box;
  return { l: `ST_GeomFromGeoJSON(${param(JSON.stringify(literal))})`, boxes: box && [box] };
}

/**
 * A relation of two geometries, each a column or a literal (Property-Property Comparisons): `ST_…(a, b)`. S_EQUALS
 * also needs the two not both empty: DuckDB's `ST_Equals` holds for two empty geometries, GEOS's DE-9IM matrix
 * doesn't (a literal is never empty; two columns can be). Written so that a NULL side stays NULL.
 */
function duckdbPair(relation: "s_intersects" | MatrixRelation, a: PairSide, b: PairSide, param: (value: SqlValue) => string): string | undefined {
  const g = (side: PairSide) => ("literal" in side ? literalGeometrySql(side.literal, param).l : columnGeometry(side.sql, side.column));
  const [ga, gb] = [g(a), g(b)];
  if (ga === undefined || gb === undefined) return undefined;
  return relation === "s_equals" ? `(ST_Equals(${ga}, ${gb}) AND NOT (ST_IsEmpty(${ga}) AND ST_IsEmpty(${gb})))` : `${ST[relation]}(${ga}, ${gb})`;
}

/** A spatial test `exact(geometry, literal)`, with the covering's comparisons first where they apply. */
function spatial(sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean, exact: (g: string, l: string) => string): string | undefined {
  const g = columnGeometry(sql, column);
  if (g === undefined) return undefined;
  const number = (x: number) => `${param(String(x))}::DOUBLE`; // as text, as the number views bind it
  const { l, boxes } = literalGeometrySql(literal, param);
  const test = exact(g, l);
  const c = column.covering?.bbox;
  for (const k of ["xmin", "ymin", "xmax", "ymax"] as const) {
    const path: unknown = c?.[k];
    if (c !== undefined && (!Array.isArray(path) || path.length !== 2 || !path.every((x) => typeof x === "string"))) {
      throw new TypeError(`covering.bbox.${k} must be the path of a field, [column, field], as GeoParquet's metadata gives it`);
    }
  }
  if (c === undefined || !positive || boxes === undefined) return test;
  const field = (path: readonly [string, string]) => `${quote(path[0])}.${quote(path[1])}`;
  const overlaps = boxes.map(([w, s, e, n]) =>
    `${field(c.xmin)} <= ${number(outward32(e!, true))} AND ${field(c.xmax)} >= ${number(outward32(w!, false))} AND ${field(c.ymin)} <= ${number(outward32(n!, true))} AND ${field(c.ymax)} >= ${number(outward32(s!, false))}`);
  return `((${overlaps.length === 1 ? overlaps[0] : overlaps.map((o) => `(${o})`).join(" OR ")}) AND ${test})`;
}

export const duckdb: Dialect = {
  placeholder: (n) => `$${n}`,
  true: "TRUE",
  false: "FALSE",
  never: "NULL::BOOLEAN",
  boolean: (value) => value,
  instant: (ms) => ms,
  view: duckdbView,
  like: (v, pattern, param) => `${v.sql} LIKE ${param(likePattern(pattern))} ESCAPE '\\'`,
  // Two columns under CASEI / ACCENTI: compared in a function, since DuckDB-WASM's functions return no text.
  compareViews: (a, op, b) =>
    a.folded && b.folded && (a.folded.folds.length > 0 || b.folded.folds.length > 0)
      ? `cql2_compare(${a.folded.text}, ${foldsText(a.folded.folds)}, ${b.folded.text}, ${foldsText(b.folded.folds)}) ${op} 0`
      : undefined,
  intersects: duckdbIntersects,
  relate: duckdbRelate,
  spatialPair: duckdbPair,
};
