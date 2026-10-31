/**
 * Dialect `sqlite`, following GeoPackage (OGC 12-128r19, version 1.4), OGC's standard for data in SQLite:
 * - a column's declared type is one of GeoPackage's (Table 1, Req 5), given here as its queryable: `BOOLEAN` →
 *   `boolean`, `TINYINT` … `INTEGER` → `integer`, `FLOAT` / `DOUBLE` / `REAL` → `number`, `TEXT` → `string`, `DATE` →
 *   `string` + `date`, `DATETIME` → `string` + `date-time`;
 * - BOOLEAN is stored as INTEGER 0 / 1, DATE as TEXT `YYYY-MM-DD`, DATETIME as TEXT `YYYY-MM-DDTHH:MM[:SS.SSS]Z`;
 * - SQLite lets a value of another type into any column, and GeoPackage says readers SHOULD allow for that. So each
 *   comparison reads a **typed view** of the column: a value of another type is NULL there, exactly as `evaluate`
 *   gives NULL for a type mismatch (values are never converted);
 * - text, CASEI, ACCENTI, LIKE, dates and instants go through registered functions ({@link sqliteFunctions}) that run
 *   `evaluate`'s own code. SQLite's own LIKE ignores ASCII case, and its `lower()` folds ASCII only;
 * - S_INTERSECTS on a geometry column (its queryable's `format` is `geometry-…`), whose values are GeoPackage blobs
 *   (or plain WKB), goes through `cql2_intersects`, which runs `evaluate`'s own engine: SQLite has no spatial
 *   functions of its own.
 */
import type { Fold } from "../../core/folds.js";
import { accentiKey, caseiKey, dayOf, instantOf, likeRegExp, plainKey } from "../../evaluate/strings.js";
import { literalParts } from "../../evaluate/spatial.js";
import { intersectsStored } from "../intersects.js";
import type { SpatialLiteral } from "../../core/types.js";
import { quote, type Dialect, type Kind, type SqlColumn, type SqlValue, type View } from "../types.js";

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
  readonly cql2_accenti: (value: unknown) => string | null;
  readonly cql2_day: (value: unknown) => string | null;
  readonly cql2_instant: (value: unknown) => number | null;
  readonly cql2_like: (value: unknown, pattern: unknown) => number | null;
  readonly cql2_intersects: (geometry: unknown, literal: unknown) => number | null;
} = {
  /** A text value, NFC-normalized. */
  cql2_text: (value) => (typeof value === "string" ? plainKey(value) : null),
  /** A text value, case-folded (CASEI). */
  cql2_casei: (value) => (typeof value === "string" ? caseiKey(value) : null),
  /** A text value without accents (ACCENTI). */
  cql2_accenti: (value) => (typeof value === "string" ? accentiKey(value) : null),
  /** A `YYYY-MM-DD` text value that exists. */
  cql2_day: (value) => dayOf(value) ?? null,
  /** An ISO 8601 date-time with `Z` or an offset that exists, as epoch milliseconds. */
  cql2_instant: (value) => instantOf(value) ?? null,
  /** 1 or 0: does the value match the LIKE pattern (already normalized or folded)? */
  cql2_like: (value, pattern) => {
    if (typeof value !== "string" || typeof pattern !== "string") return null;
    return cachedLike(pattern).test(value) ? 1 : 0;
  },
  /**
   * 1 or 0: does a stored geometry (a GeoPackage blob, or WKB) intersect the literal (its JSON)? NULL for a NULL or a
   * value that isn't a geometry. `evaluate`'s own engine decides.
   */
  cql2_intersects: intersectsStored,
};

/**
 * A column read as values of this kind: anything else is NULL there. Checked on each value, not from the declared
 * type, since any column may hold a value of another type. One exception: SQLite stores no booleans, so only a column
 * declared BOOLEAN has them, as GeoPackage's 0 / 1, which are then not numbers (the application reads them as
 * `false` / `true`). `undefined`: no value can ever be of that kind.
 */
function sqliteView(sql: string, kind: Kind, column: SqlColumn, _fn: (name: string) => string, folds: readonly Fold[]): View | undefined {
  const numeric = `typeof(${sql}) IN ('integer', 'real')`;
  const view = (expression: string): View => ({ sql: expression, cast: "" });
  switch (kind) {
    case "text":
      return view(`cql2_text(${sql})`);
    case "fold":
      return view(folds.reduce((expression, fold) => `cql2_${fold}(${expression})`, sql));
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

/**
 * S_INTERSECTS(column, literal): `evaluate`'s engine through `cql2_intersects`, the literal as JSON text (one parameter,
 * read once per query). A GeoPackage blob's header envelope rejects most rows before the WKB is decoded. `undefined`
 * for a column that isn't a geometry.
 *
 * With the column's R-tree (`rtree`), and only for a leaf that isn't negated (`positive`), the candidates come first
 * from the R-tree: `rowid IN (SELECT id FROM rtree WHERE <the boxes overlap>) AND …`. GeoPackage's R-tree leaves out
 * NULL and empty geometries, so this gives FALSE where `evaluate` gives NULL, which selects the same rows only there;
 * under a NOT the function alone decides. The R-tree's 32-bit floats are rounded outward, so it loses no row.
 */
function sqliteIntersects(sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean): string | undefined {
  if (typeof column.format !== "string" || !column.format.startsWith("geometry-")) return undefined;
  // Placeholders are positional (`?`): each parameter is added where it stands in the SQL.
  const exact = () => `cql2_intersects(${sql}, ${param(JSON.stringify(literal))}) = 1`;
  if (column.rtree === undefined || !positive) return exact();
  let boxes: number[][];
  if ("bbox" in literal && !("type" in literal)) {
    const b = literal.bbox;
    const [west, south, east, north] = b.length === 4 ? b : [b[0], b[1], b[3], b[4]];
    boxes = west > east ? [[west, south, 180, north], [-180, south, east, north]] : [[west, south, east, north]]; // across the antimeridian: two
  } else {
    const box = literalParts(literal).box;
    if (!box) return exact(); // an empty literal: nothing to look up
    boxes = [box];
  }
  const overlaps = boxes.map(([w, s, e, n]) => `(minx <= ${param(e!)} AND maxx >= ${param(w!)} AND miny <= ${param(n!)} AND maxy >= ${param(s!)})`);
  return `(rowid IN (SELECT id FROM ${quote(column.rtree)} WHERE ${overlaps.join(" OR ")}) AND ${exact()})`;
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
  intersects: sqliteIntersects,
};
