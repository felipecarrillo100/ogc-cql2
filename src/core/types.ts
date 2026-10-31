/**
 * CQL2-JSON (OGC 21-065r2, the JSON encoding) for the package's profile: Basic CQL2, Advanced Comparison Operators
 * and Case-insensitive Comparison.
 *
 * The shapes are the portable ones every server of those classes must accept: a property on the left and a literal
 * on the right (`/per/basic-cql2/cql2filter` and `/per/advanced-comparison-operators/*` let a server refuse
 * anything else). `validate` checks a value against them; these types describe what it lets through.
 */

/**
 * What a property holds, as a queryable describes it (OGC API Features Part 3): the JSON Schema `type` (or a list of
 * them, `["string", "null"]` for a nullable one), and `format` for dates (`date`) and instants (`date-time`). A queryables response's `properties` can be passed as it comes; other
 * keys (`title`, `description`…) are ignored. `string`, `number`, `integer` and `boolean` can be compared; other types
 * (`array`, `object`) and geometries (`format: "geometry-…"`) can only be tested with `isNull` in the profile.
 */
export interface Queryable {
  readonly type?: string | readonly string[];
  readonly format?: string;
}

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

/** `CASEI(property)`: the property's value, case-folded; it may wrap `ACCENTI(property)`. */
export interface CaseiProperty {
  readonly op: "casei";
  readonly args: readonly [PropertyRef | AccentiOf<PropertyRef>];
}

/** `CASEI('text')`: a string literal, case-folded; it may wrap `ACCENTI('text')`. */
export interface CaseiString {
  readonly op: "casei";
  readonly args: readonly [string | AccentiOf<string>];
}

/** `ACCENTI(property)`: the property's value without accents; it may wrap `CASEI(property)`. */
export interface AccentiProperty {
  readonly op: "accenti";
  readonly args: readonly [PropertyRef | CaseiOf<PropertyRef>];
}

/** `ACCENTI('text')`: a string literal without accents; it may wrap `CASEI('text')`. */
export interface AccentiString {
  readonly op: "accenti";
  readonly args: readonly [string | CaseiOf<string>];
}

/** `CASEI(x)` of a property or a string, one level: the inner part of `ACCENTI(CASEI(x))`. */
export interface CaseiOf<T extends PropertyRef | string> {
  readonly op: "casei";
  readonly args: readonly [T];
}

/** `ACCENTI(x)` of a property or a string, one level: the inner part of `CASEI(ACCENTI(x))`. */
export interface AccentiOf<T extends PropertyRef | string> {
  readonly op: "accenti";
  readonly args: readonly [T];
}

/** The left side of a string comparison: a property, or `CASEI` / `ACCENTI` of one. */
export type StringSubject = PropertyRef | CaseiProperty | AccentiProperty;

/** A string folded by `CASEI` and / or `ACCENTI`. */
export type FoldedString = CaseiString | AccentiString;

export type ComparisonOperator = "=" | "<>" | "<" | "<=" | ">" | ">=";

/** `property op literal`. With `casei` or `accenti` on either side, the other side is a string or a folded string. */
export interface Comparison {
  readonly op: ComparisonOperator;
  readonly args: readonly [StringSubject, ScalarLiteral | FoldedString];
}

/** `property LIKE 'pattern'`: `%` matches any run of characters, `_` one character, `\` escapes either. */
export interface Like {
  readonly op: "like";
  readonly args: readonly [StringSubject, string | FoldedString];
}

/** `property BETWEEN low AND high`, inclusive; numbers only. */
export interface Between {
  readonly op: "between";
  readonly args: readonly [PropertyRef, number, number];
}

/** `property IN (…)`: the list holds literals of one type. */
export interface In {
  readonly op: "in";
  readonly args: readonly [StringSubject, readonly (ScalarLiteral | FoldedString)[]];
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
