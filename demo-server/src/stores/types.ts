/**
 * The store layer: one store per collection. The server talks only to this interface, so a GeoJSON file, a SQLite
 * table or (later) a PostgreSQL table are interchangeable behind it.
 */
import type { Cql2Filter } from "ogc-cql2";
import { CONFORMANCE } from "ogc-cql2";

export type FeatureId = string | number;

/** A GeoJSON feature, as every store returns it, whatever it reads. */
export interface Feature {
  readonly type: "Feature";
  readonly id: FeatureId;
  readonly geometry: unknown;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** A queryable property, as OGC API Features Part 3 describes one: a JSON Schema. No `type` when it is unknown. */
export interface Queryable {
  readonly type?: "string" | "number" | "integer" | "boolean";
  readonly format?: "date" | "date-time";
}

export interface CollectionDescription {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly source: string;
  readonly featureCount: number;
  /** What the store had to report about its data: dropped duplicates, properties of mixed types… */
  readonly warnings: readonly string[];
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

export interface QueryResult {
  readonly features: readonly Feature[];
  /** How many features match, over all pages. */
  readonly numberMatched: number;
}

/** The classes every store evaluates: GeoJSON with ogc-cql2/evaluate, the others in their database. */
export const BASE_CLASSES: readonly string[] = [
  CONFORMANCE.basic, CONFORMANCE.advancedComparison, CONFORMANCE.caseInsensitive, CONFORMANCE.accentInsensitive,
  CONFORMANCE.basicSpatial, CONFORMANCE.basicSpatialPlus, CONFORMANCE.propertyProperty,
];

export interface Store {
  describe(): CollectionDescription;
  queryables(): Readonly<Record<string, Queryable>>;
  /** Whether the features have a geometry that filters can use (a table without one, or in another SRS, has none). */
  hasGeometry(): boolean;
  /** The CQL2 conformance classes this store evaluates: {@link BASE_CLASSES}, and Spatial Functions where it can. */
  conformance(): readonly string[];
  /** The features the filter selects (TRUE), in the store's order, one page of them. The filter is valid. */
  query(filter: Cql2Filter, page: Page): Promise<QueryResult>;
}
