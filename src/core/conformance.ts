/**
 * The CQL2 1.0 conformance classes, as servers declare them (OGC API `/conformance`).
 *
 * `CQL2_CONFORMANCE` are all of the standard's classes a filter can need; `CONFORMANCE` are the ones this package
 * implements. The others are named in its refusals, so a caller can tell which class a filter outside the profile
 * would need.
 */
const BASE = "http://www.opengis.net/spec/cql2/1.0/conf/";

/**
 * CQL2 1.0's filter classes, all twelve: fixed, as the standard is. Not the two encoding classes (`cql2-text`,
 * `cql2-json`), which name an encoding rather than something a filter needs.
 */
export const CQL2_CONFORMANCE: {
  readonly basic: string;
  readonly advancedComparison: string;
  readonly caseInsensitive: string;
  readonly accentInsensitive: string;
  readonly basicSpatial: string;
  readonly basicSpatialPlus: string;
  readonly spatial: string;
  readonly temporal: string;
  readonly arrays: string;
  readonly propertyProperty: string;
  readonly functions: string;
  readonly arithmetic: string;
} = {
  basic: `${BASE}basic-cql2`,
  advancedComparison: `${BASE}advanced-comparison-operators`,
  caseInsensitive: `${BASE}case-insensitive-comparison`,
  accentInsensitive: `${BASE}accent-insensitive-comparison`,
  basicSpatial: `${BASE}basic-spatial-functions`,
  basicSpatialPlus: `${BASE}basic-spatial-functions-plus`,
  spatial: `${BASE}spatial-functions`,
  temporal: `${BASE}temporal-functions`,
  arrays: `${BASE}array-functions`,
  propertyProperty: `${BASE}property-property`,
  functions: `${BASE}functions`,
  arithmetic: `${BASE}arithmetic`,
};

/** The classes this package implements: it only grows. */
export const CONFORMANCE: {
  readonly basic: string;
  readonly advancedComparison: string;
  readonly caseInsensitive: string;
  readonly accentInsensitive: string;
  readonly basicSpatial: string;
  readonly basicSpatialPlus: string;
  readonly spatial: string;
} = {
  basic: CQL2_CONFORMANCE.basic,
  advancedComparison: CQL2_CONFORMANCE.advancedComparison,
  caseInsensitive: CQL2_CONFORMANCE.caseInsensitive,
  accentInsensitive: CQL2_CONFORMANCE.accentInsensitive,
  basicSpatial: CQL2_CONFORMANCE.basicSpatial,
  basicSpatialPlus: CQL2_CONFORMANCE.basicSpatialPlus,
  spatial: CQL2_CONFORMANCE.spatial,
};
