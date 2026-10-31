/**
 * Refusing a valid filter of a class a part doesn't evaluate (yet): the spatial ones, whose engines come in phases.
 * Internal to the package.
 */
import { CONFORMANCE } from "./conformance.js";
import { Cql2Error } from "./errors.js";

const NAMES: ReadonlyMap<string, string> = new Map([
  [CONFORMANCE.basicSpatial, "Basic Spatial Functions"],
  [CONFORMANCE.basicSpatialPlus, "Basic Spatial Functions with additional Spatial Literals"],
  [CONFORMANCE.spatial, "Spatial Functions"],
]);

/** The spatial classes `evaluate` doesn't evaluate yet: the relations other than S_INTERSECTS. */
export const NOT_IN_EVALUATE: readonly string[] = [CONFORMANCE.spatial];

/** The spatial classes the SQL dialects don't translate yet: all three. */
export const NOT_IN_SQL: readonly string[] = [CONFORMANCE.basicSpatial, CONFORMANCE.basicSpatialPlus, CONFORMANCE.spatial];

/**
 * @throws Cql2Error `unsupported` when `classes` (a filter's `requiredConformance`) holds one of `notEvaluated`, with
 * `details.conformance`.
 */
export function refuseUnsupported(classes: readonly string[], notEvaluated: readonly string[], what: string): void {
  const missing = classes.find((c) => notEvaluated.includes(c));
  if (missing === undefined) return;
  throw new Cql2Error(
    "unsupported",
    `${what} doesn't evaluate ${NAMES.get(missing)} yet; validate and toText accept them, to send to a server.`,
    "",
    { conformance: missing },
  );
}
