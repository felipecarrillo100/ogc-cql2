/**
 * The classes `evaluate` and `toSql` don't evaluate yet: the spatial ones (their engines come in later versions).
 * Internal to the package.
 */
import { CONFORMANCE } from "./conformance.js";
import { Cql2Error } from "./errors.js";

const NOT_EVALUATED: ReadonlyMap<string, string> = new Map([
  [CONFORMANCE.basicSpatial, "Basic Spatial Functions"],
  [CONFORMANCE.basicSpatialPlus, "Basic Spatial Functions with additional Spatial Literals"],
  [CONFORMANCE.spatial, "Spatial Functions"],
]);

/**
 * @throws Cql2Error `unsupported` when `classes` (a filter's `requiredConformance`) holds one that `what` can't
 * evaluate yet, with `details.conformance`.
 */
export function refuseUnsupported(classes: readonly string[], what: string): void {
  const missing = classes.find((c) => NOT_EVALUATED.has(c));
  if (missing === undefined) return;
  throw new Cql2Error(
    "unsupported",
    `${what} doesn't evaluate spatial filters yet (${NOT_EVALUATED.get(missing)}); validate and toText accept them, to send to a server.`,
    "",
    { conformance: missing },
  );
}
