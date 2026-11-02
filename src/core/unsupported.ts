/**
 * Refusing a valid filter of a class an engine doesn't evaluate with the options it was given (Spatial Functions
 * without a geometry engine, in `evaluate` and in SQLite without SpatiaLite). The engines' own lists
 * (`evaluateConformance`, `sqlConformance`) decide, so a filter valid against a list is never refused here.
 * Internal to the package.
 */
import { CONFORMANCE } from "./conformance.js";
import { Cql2Error } from "./errors.js";

const NAMES: ReadonlyMap<string, string> = new Map([
  [CONFORMANCE.basic, "Basic CQL2"],
  [CONFORMANCE.advancedComparison, "Advanced Comparison Operators"],
  [CONFORMANCE.caseInsensitive, "Case-insensitive Comparison"],
  [CONFORMANCE.accentInsensitive, "Accent-insensitive Comparison"],
  [CONFORMANCE.basicSpatial, "Basic Spatial Functions"],
  [CONFORMANCE.basicSpatialPlus, "Basic Spatial Functions with additional Spatial Literals"],
  [CONFORMANCE.spatial, "Spatial Functions"],
  [CONFORMANCE.propertyProperty, "Property-Property Comparisons"],
  [CONFORMANCE.arithmetic, "Arithmetic Expressions"],
  [CONFORMANCE.temporal, "Temporal Functions"],
]);

/** Every class the package implements, but `except`: in `CONFORMANCE`'s order, a new array each time. */
export const implementedBut = (except: readonly string[]): string[] =>
  Object.values(CONFORMANCE).filter((c) => !except.includes(c));

/**
 * @throws Cql2Error `unsupported` when `classes` (a filter's `requiredConformance`) holds one not in `supported`, with
 * `details.conformance`.
 */
export function refuseUnsupported(classes: readonly string[], supported: readonly string[], what: string): void {
  const missing = classes.find((c) => !supported.includes(c));
  if (missing === undefined) return;
  throw new Cql2Error(
    "unsupported",
    `${what} doesn't evaluate ${NAMES.get(missing) ?? missing}; validate and toText accept it, to send to a server.`,
    "",
    { conformance: missing },
  );
}
