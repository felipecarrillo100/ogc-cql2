/** Why the package refused something. Each code is stable: test it, not the message. */
export type Cql2ErrorCode =
  /** `assertValid`: the value isn't a valid filter in the profile; `details.problems` says why. */
  | "invalid-filter"
  /** `toText`: the filter is valid, but CQL2-text can't express it; `details.problem` says what. */
  | "not-expressible"
  /** `toSql`: the filter references a property that isn't one of the table's columns; `details.property` names it. */
  | "unknown-property"
  /**
   * `evaluate`, `toSql`: the filter is valid, but uses a conformance class this part doesn't evaluate (yet);
   * `details.conformance` names it.
   */
  | "unsupported";

/**
 * The error every refusal throws.
 *
 * Test `error.code`, or `error.name === "Cql2Error"`, rather than `instanceof`: two copies of the package in one
 * application have two classes, but the same codes.
 */
export class Cql2Error extends Error {
  override readonly name: "Cql2Error" = "Cql2Error";
  readonly code: Cql2ErrorCode;
  /** Where in the filter, as a JSON Pointer (`""` is the whole filter, `/args/0` its first argument). */
  readonly path: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: Cql2ErrorCode, message: string, path = "", details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.code = code;
    this.path = path;
    this.details = details;
  }
}
