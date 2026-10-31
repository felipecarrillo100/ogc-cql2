/**
 * The CQL2 1.0 conformance classes, as servers declare them (OGC API `/conformance`).
 *
 * `PROFILE` are the classes this package implements; `OTHER` are named in its refusals, so a caller can tell which
 * class a filter outside the profile would need.
 */
const BASE = "http://www.opengis.net/spec/cql2/1.0/conf/";

/** The classes this package implements. */
export const CONFORMANCE: {
  readonly basic: string;
  readonly advancedComparison: string;
  readonly caseInsensitive: string;
  readonly accentInsensitive: string;
  readonly basicSpatial: string;
  readonly basicSpatialPlus: string;
  readonly spatial: string;
} = {
  basic: `${BASE}basic-cql2`,
  advancedComparison: `${BASE}advanced-comparison-operators`,
  caseInsensitive: `${BASE}case-insensitive-comparison`,
  accentInsensitive: `${BASE}accent-insensitive-comparison`,
  basicSpatial: `${BASE}basic-spatial-functions`,
  basicSpatialPlus: `${BASE}basic-spatial-functions-plus`,
  spatial: `${BASE}spatial-functions`,
};

/** The standard's other classes, which this package doesn't implement yet. */
export const OTHER_CONFORMANCE: {
  readonly temporal: string;
  readonly arrays: string;
  readonly propertyProperty: string;
  readonly functions: string;
  readonly arithmetic: string;
} = {
  temporal: `${BASE}temporal-functions`,
  arrays: `${BASE}array-functions`,
  propertyProperty: `${BASE}property-property`,
  functions: `${BASE}functions`,
  arithmetic: `${BASE}arithmetic`,
};
