/**
 * CQL2-JSON (OGC 21-065r2, the JSON encoding) for the package's profile: Basic CQL2, Advanced Comparison Operators
 * and Case-insensitive Comparison.
 *
 * The shapes are the portable ones every server of those classes must accept: a property on the left and a literal
 * on the right (`/per/basic-cql2/cql2filter` and `/per/advanced-comparison-operators/*` let a server refuse
 * anything else). `validate` checks a value against them; these types describe what it lets through.
 */

/** A reference to a property of the features, `{ "property": "name" }`. */
export interface PropertyRef {
  readonly property: string;
}

/** A calendar date, `{ "date": "YYYY-MM-DD" }`. */
export interface DateLiteral {
  readonly date: string;
}

/** An instant in UTC, `{ "timestamp": "YYYY-MM-DDThh:mm:ss[.fff]Z" }`. */
export interface TimestampLiteral {
  readonly timestamp: string;
}

export type InstantLiteral = DateLiteral | TimestampLiteral;

/** A literal a property can be compared with. */
export type ScalarLiteral = string | number | boolean | InstantLiteral;

/** `CASEI(property)`: the property's value, case-folded. */
export interface CaseiProperty {
  readonly op: "casei";
  readonly args: readonly [PropertyRef];
}

/** `CASEI('text')`: a string literal, case-folded. */
export interface CaseiString {
  readonly op: "casei";
  readonly args: readonly [string];
}

export type ComparisonOperator = "=" | "<>" | "<" | "<=" | ">" | ">=";

/** `property op literal`. With `casei` on either side, the other side is a string or a `casei` string. */
export interface Comparison {
  readonly op: ComparisonOperator;
  readonly args: readonly [PropertyRef | CaseiProperty, ScalarLiteral | CaseiString];
}

/** `property LIKE 'pattern'`: `%` matches any run of characters, `_` one character, `\` escapes either. */
export interface Like {
  readonly op: "like";
  readonly args: readonly [PropertyRef | CaseiProperty, string | CaseiString];
}

/** `property BETWEEN low AND high`, inclusive; numbers only. */
export interface Between {
  readonly op: "between";
  readonly args: readonly [PropertyRef, number, number];
}

/** `property IN (…)`: the list holds literals of one type. */
export interface In {
  readonly op: "in";
  readonly args: readonly [PropertyRef | CaseiProperty, readonly (ScalarLiteral | CaseiString)[]];
}

/** `property IS NULL`. */
export interface IsNull {
  readonly op: "isNull";
  readonly args: readonly [PropertyRef];
}

/** `AND` / `OR` of two or more filters. */
export interface AndOr {
  readonly op: "and" | "or";
  readonly args: readonly Cql2Filter[];
}

/** `NOT` of one filter. */
export interface Not {
  readonly op: "not";
  readonly args: readonly [Cql2Filter];
}

/** A CQL2-JSON filter in the profile. `true` and `false` are filters too: all features, or none. */
export type Cql2Filter = boolean | Comparison | Like | Between | In | IsNull | AndOr | Not;
