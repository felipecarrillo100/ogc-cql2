/**
 * The public types of `ogc-cql2/sql`, and the interface each dialect implements (`dialects/*.ts`): what differs per
 * database, so that `toSql` keeps one walker for all of them.
 */

import type { Fold } from "../core/folds.js";
import type { MatrixRelation } from "../core/relate.js";
import type { Queryable, SpatialLiteral } from "../core/types.js";

export type SqlDialect = "sqlite" | "postgres" | "duckdb";

/** A table column, as its queryable describes it. Without a `type`, its values' types are checked as they come. */
export interface SqlColumn extends Queryable {
  readonly type?: "string" | "number" | "integer" | "boolean";
  /** `date`, `date-time`, or a geometry (`geometry-point`, `geometry-any`…, as OGC API Features Part 3 writes it). */
  readonly format?: "date" | "date-time" | `geometry-${string}`;
  /** The column's name in the table, when it isn't the property's name. */
  readonly column?: string;
  /**
   * `postgres` and `duckdb`: the declared type (`text`, `integer`, `timestamp with time zone`…; `VARCHAR`, `BIGINT`,
   * `TIMESTAMP WITH TIME ZONE`…); else derived from `type`. For PostGIS, `geometry` (or `geometry(Point, 4326)`…)
   * and `geography`.
   */
  readonly sqlType?: string;
  /**
   * `postgres`: a geometry column's SRID, when it isn't 4326 and `sqlType` doesn't say it (`geometry(Point, 3857)`).
   * The column is then transformed to 4326, so the comparison is planar in CRS84, as CQL2's is.
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
}

export interface SqlOptions {
  readonly dialect: SqlDialect;
  /** The properties a filter may use, and their columns: the table's queryables. */
  readonly columns: Readonly<Record<string, SqlColumn>>;
  /** `postgres`: the schema of the `cql2_*` functions (see `postgresFunctions`), when not on the search path. */
  readonly functionSchema?: string;
  /**
   * `sqlite`: SpatiaLite is loaded on the connection (`mod_spatialite`), so the Spatial Functions class (S_WITHIN,
   * S_TOUCHES, …) is translated, GEOS deciding. Without it the class is refused (`unsupported`); S_INTERSECTS needs
   * no SpatiaLite.
   */
  readonly spatialite?: boolean;
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
  /**
   * The column read as `kind`; `undefined` when no value can ever be of that kind. `folds`: for `fold`, what the value
   * goes through, innermost first.
   */
  view(sql: string, kind: Kind, column: SqlColumn, fn: (name: string) => string, folds: readonly Fold[]): View | undefined;
  /** `view LIKE pattern`, the pattern keyed as `evaluate` keys it; `param` adds a parameter. */
  like(view: View, pattern: string, param: (value: SqlValue) => string): string;
  /**
   * S_INTERSECTS(column, literal), exactly as `evaluate` decides it; `undefined` when the column holds no geometry
   * (no value can match). Absent: the dialect has no spatial SQL yet, and spatial filters are `unsupported`.
   * `positive`: the leaf is under an even number of NOTs. There, giving FALSE where `evaluate` gives NULL selects the
   * same rows (in three-valued logic, a condition TRUE with a NULL leaf is TRUE with a FALSE one, and NOT is the only
   * operator that turns FALSE into TRUE), so a prefilter that leaves out rows without a geometry is exact.
   */
  intersects?(sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean): string | undefined;
  /**
   * The other relations of Spatial Functions but S_DISJOINT (written as NOT S_INTERSECTS): S_EQUALS, S_TOUCHES,
   * S_WITHIN, S_OVERLAPS, S_CROSSES, S_CONTAINS of (column, literal), as their DE-9IM patterns decide them;
   * `undefined` when the column holds no geometry. Absent: the class is `unsupported`. `positive` as for `intersects`.
   */
  relate?(relation: MatrixRelation, sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string, positive: boolean): string | undefined;
}

export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
