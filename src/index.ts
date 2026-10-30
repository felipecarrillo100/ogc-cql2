/**
 * ogc-cql2: OGC CQL2 for JavaScript and TypeScript.
 *
 * Implements CQL2 1.0.0, the Common Query Language (OGC 21-065r2):
 * https://docs.ogc.org/is/21-065r2/21-065r2.html
 */

/** The version of the CQL2 standard this package implements. */
export const CQL2_VERSION: "1.0.0" = "1.0.0";

export type * from "./core/types.js";
export { Cql2Error, type Cql2ErrorCode } from "./core/errors.js";
export { CONFORMANCE, OTHER_CONFORMANCE } from "./core/conformance.js";
