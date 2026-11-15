/**
 * The public types of `ogc-cql2/sql`, and the interface each dialect implements (`dialects/*.ts`): what differs per
 * database, so that `toSql` keeps one walker for all of them.
 */

import type { Fold } from "../core/folds.js";
import type { MatrixRelation } from "../core/relate.js";
import type { ArithmeticOperator, Queryable, SpatialLiteral } from "../core/types.js";

export type SqlDialect = "sqlite" | "postgres" | "duckdb" | "oracle" | "sqlserver";

/** A table column, as its queryable describes it. Without a `type`, its values' types are checked as they come. */
export interface SqlColumn extends Queryable {
  readonly type?: "string" | "number" | "integer" | "boolean";
  /** `date`, `date-time`, or a geometry (`geometry-point`, `geometry-any`…, as OGC API Features Part 3 writes it). */
  readonly format?: "date" | "date-time" | `geometry-${string}`;
  /** The column's name in the table, when it isn't the property's name. */
  readonly column?: string;
  /**
   * `postgres`, `duckdb`, `oracle` and `sqlserver`: the declared type (`text`, `integer`, `timestamp with time zone`…; `VARCHAR`,
   * `BIGINT`, `TIMESTAMP WITH TIME ZONE`…; `VARCHAR2`, `NUMBER`, `TIMESTAMP(6) WITH TIME ZONE`…, as `USER_TAB_COLUMNS`
   * names it); else derived from `type`. For PostGIS, `geometry` (or `geometry(Point, 4326)`…) and `geography`. An
   * Oracle DATE holds a time: it is a date-time with no zone, unless `format` is `date`, which reads it as its day.
   */
  readonly sqlType?: string;
  /**
   * `postgres`: a geometry column's SRID, when it isn't 4326 and `sqlType` doesn't say it (`geometry(Point, 3857)`).
   * The column is then transformed to 4326, so the comparison is planar in CRS84, as CQL2's is.
   * `sqlserver`: a geometry column's SRID, when it isn't 4326: the literal is built in it (SQL Server's geometry is
   * planar whatever its SRID, so nothing is transformed; the coordinates are compared as given).
   */
  readonly srid?: number;
  /**
   * `sqlite`: the R-tree of a geometry column (GeoPackage's `rtree_<table>_<column>`), used to find the candidate rows
   * by their `rowid` before the exact test. Only for a filter that isn't negated: negate the filter (`{ op: "not" }`),
   * never the SQL it gives (`NOT (…)`).
   */
  readonly rtree?: string;
  /**
   * `duckdb`: GeoParquet's bbox covering of a geometry column (GeoParquet 1.1, "bbox covering encoding"), as the
   * file's `geo` metadata gives it (`geo.columns.<column>.covering`): each of `xmin`, `ymin`, `xmax`, `ymax` the
   * path of a field, `[column, field]`, e.g. `["bbox", "xmin"]`. The filter then compares those fields first, which
   * skips Parquet row groups and most rows; DuckDB doesn't use a covering by itself. Only for a filter that isn't
   * negated: negate the filter (`{ op: "not" }`), never the SQL it gives (`NOT (…)`). Not for a table with an R-tree
   * index on the geometry, which is faster on its own; DuckDB 2.0 then fails with an internal error (1.4 and 1.5
   * don't).
   */
  readonly covering?: { readonly bbox: { readonly [K in "xmin" | "ymin" | "xmax" | "ymax"]: readonly [string, string] } };
  /**
   * `oracle`: the geometry column has a planar spatial index, on `cql2_planar(column)` (see `oracleFunctions`). The
   * filter then finds the candidates through it first (`SDO_FILTER`), before the exact test; without the index
   * `SDO_FILTER` fails, so the dialect must be told. A column's own SRID 4326 index can't serve: it is geodetic, and
   * loses planar candidates. Create the planar index once (schema, table and column as the dictionary names them):
   * ```sql
   * INSERT INTO user_sdo_geom_metadata VALUES ('TABLE', 'SCHEMA.CQL2_PLANAR(COLUMN)',
   *   SDO_DIM_ARRAY(SDO_DIM_ELEMENT('X', -180, 180, 1e-10), SDO_DIM_ELEMENT('Y', -90, 90, 1e-10)), NULL);
   * CREATE INDEX table_planar ON table (cql2_planar(column)) INDEXTYPE IS MDSYS.SPATIAL_INDEX_V2;
   * ```
   * Only for a filter that isn't negated: negate the filter (`{ op: "not" }`), never the SQL it gives (`NOT (…)`).
   */
  readonly spatialIndex?: boolean;
}

export interface SqlOptions {
  readonly dialect: SqlDialect;
  /** The properties a filter may use, and their columns: the table's queryables. */
  readonly columns: Readonly<Record<string, SqlColumn>>;
  /**
   * `postgres`: the schema of the `cql2_*` functions (see `postgresFunctions`), when not on the search path. `oracle`:
   * their schema (see `oracleFunctions`), as the data dictionary names it, when not the connection's own. `sqlserver`:
   * their schema (see `sqlserverFunctions`), default `dbo`.
   */
  readonly functionSchema?: string;
  /**
   * `sqlite`: SpatiaLite is loaded on the connection (`mod_spatialite`), so the Spatial Functions class (S_WITHIN,
   * S_TOUCHES, …) is translated, GEOS deciding. Without it the class is refused (`unsupported`); S_INTERSECTS needs
   * no SpatiaLite. A GeometryCollection literal needs SpatiaLite built with GEOS 3.13 or later.
   */
  readonly spatialite?: boolean;
}

/** A parameter's value. */
export type SqlValue = string | number | boolean;

export interface SqlWhere {
  /**
   * The condition, for `WHERE …`. Values are placeholders: `?` (`sqlite`), `$1`, `$2` … (`postgres`, `duckdb`), `:1`,
   * `:2` … (`oracle`, each read once, so the values bind by position), `@p1`, `@p2` … (`sqlserver`, named: bind
   * `params[i]` as `p<i+1>`).
   */
  readonly where: string;
  /** The values, in placeholder order. */
  readonly params: readonly SqlValue[];
}

// --- The dialect interface (internal) ----------------------------------------------------------------------------

/**
 * The type of value a literal needs, and so the view of the column it is compared with. `fold`: a string under CASEI
 * and / or ACCENTI, whose folds come with the view.
 */
export type Kind = "text" | "fold" | "number" | "boolean" | "day" | "instant";

/** A column read as one kind of value. */
export interface View {
  /** The SQL expression. */
  readonly sql: string;
  /** The cast its parameters need (`postgres`, `duckdb`). */
  readonly cast: string;
  /** The literal's value as this view compares it, when it isn't the literal's own (a day as a number). */
  readonly value?: (value: SqlValue) => SqlValue;
  /**
   * The parameter (with its cast) in an expression, when the view compares it as one (`oracle`: TO_BINARY_DOUBLE);
   * `value` is the literal's own value, for a form that depends on it.
   */
  readonly wrap?: (param: string, value: SqlValue) => string;
  /** The condition `view op param`, when it isn't `sql op param`. */
  readonly compare?: (op: string, param: string) => string;
  /** The condition `view LIKE pattern`, when it isn't the dialect's. */
  readonly like?: (pattern: string, param: (value: SqlValue) => string) => string;
  /**
   * The expression to compare with another column's view of the same kind (Property-Property Comparisons), when it
   * isn't `sql`: a form both columns share (a day as a number, for a DATE column against dates held as text).
   */
  readonly pair?: string;
  /**
   * A day or an instant view of a column that can hold `infinity` and keeps its index (a PostgreSQL or DuckDB DATE): the
   * condition that the value is finite. Such a value is NULL in `evaluate` (it is served as no date), so the view's
   * comparisons with a literal take it as NULL (see `toSql`). Its `pair` is NULL there already.
   */
  readonly finite?: string;
  /** `duckdb`: the text and the folds behind a text or folded view, for comparing two of them in a function. */
  readonly folded?: { readonly text: string; readonly folds: readonly Fold[] };
}

export interface Dialect {
  /** The placeholder of the `n`th parameter, from 1. */
  placeholder(n: number): string;
  readonly true: string;
  readonly false: string;
  /** No value can match: NULL, typed so that it fits wherever SQL expects a condition. */
  readonly never: string;
  /**
   * The database reads `''` as NULL (Oracle), so no column holds `''`: a comparison of a text view with an empty
   * string literal is decided when the SQL is built, as `evaluate` decides it on the served values (`= < <=` and
   * LIKE `''` FALSE, `<> > >=` TRUE, NULL where the value is NULL).
   */
  readonly emptyStringIsNull?: boolean;
  /**
   * The database has no boolean values (SQL Server): a condition as a value, 1, 0 or NULL, where the walker uses one
   * as a value (`CASE WHEN … THEN <condition> END`, `COALESCE` of conditions). Without it, conditions are values.
   */
  truth?(condition: string): string;
  /** The schema of the `cql2_*` functions when `functionSchema` isn't given (SQL Server calls them by two-part name). */
  readonly functionSchema?: string;
  /** A boolean literal, as a parameter value. */
  boolean(value: boolean): SqlValue;
  /** An instant literal (epoch milliseconds), as a parameter value. */
  instant(ms: number): SqlValue;
  /**
   * The column read as `kind`; `undefined` when no value can ever be of that kind. `folds`: for `fold`, what the value
   * goes through, innermost first.
   */
  view(sql: string, kind: Kind, column: SqlColumn, fn: (name: string) => string, folds: readonly Fold[]): View | undefined;
  /** `view LIKE pattern`, the pattern keyed as `evaluate` keys it; `param` adds a parameter. */
  like(view: View, pattern: string, param: (value: SqlValue) => string): string;
  /** A number literal as a double, for arithmetic (Arithmetic Expressions); `param` adds a parameter. */
  number(value: number, param: (value: SqlValue) => string): string;
  /**
   * `a op b` of two doubles, exactly as `evaluate` computes it (`ogc-cql2`'s rules: `div` toward zero, `%` its
   * remainder, NULL for a result that isn't a finite number), and never an error.
   */
  arithmetic(op: ArithmeticOperator, a: string, b: string, fn: (name: string) => string): string;
  /** `a op b` for two columns' views of one kind, when it isn't `a.pair ?? a.sql op b.pair ?? b.sql`. */
  compareViews?(a: View, op: string, b: View): string | undefined;
  /**
   * S_INTERSECTS(column, literal), exactly as `evaluate` decides it; `undefined` when the column holds no geometry
   * (no value can match). Absent: the dialect has no spatial SQL yet, and spatial filters are `unsupported`.
   * `positive`: the leaf is under an even number of NOTs. There, giving FALSE where `evaluate` gives NULL selects the
   * same rows (in three-valued logic, a condition TRUE with a NULL leaf is TRUE with a FALSE one, and NOT is the only
   * operator that turns FALSE into TRUE), so a prefilter that leaves out rows without a geometry is exact.
   */
  intersects?(sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean, fn: (name: string) => string): string | undefined;
  /**
   * The other relations of Spatial Functions but S_DISJOINT (written as NOT S_INTERSECTS): S_EQUALS, S_TOUCHES,
   * S_WITHIN, S_OVERLAPS, S_CROSSES, S_CONTAINS of (column, literal), as their DE-9IM patterns decide them;
   * `undefined` when the column holds no geometry. Absent: the class is `unsupported`. `positive` as for `intersects`.
   */
  relate?(relation: MatrixRelation, sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean, fn: (name: string) => string): string | undefined;
  /**
   * A relation of two geometry columns, or of a column and a literal in the database's own terms, or (but for
   * S_INTERSECTS) of two literals (Property-Property Comparisons): S_INTERSECTS, or one of `relate`'s, exactly as
   * `evaluate` decides it; `undefined` when a column holds no geometry. No prefilter: neither side is a constant box.
   */
  spatialPair?(relation: "s_intersects" | MatrixRelation, a: PairSide, b: PairSide, param: (value: SqlValue) => string, fn: (name: string) => string): string | undefined;
}

/** A side of a spatial relation of two geometries: a column, or a literal. */
export type PairSide = { readonly sql: string; readonly column: SqlColumn } | { readonly literal: SpatialLiteral };

export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
