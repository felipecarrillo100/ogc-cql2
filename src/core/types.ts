/**
 * CQL2-JSON (OGC 21-065r2, the JSON encoding) for the package's profile: Basic CQL2, Advanced Comparison Operators
 * and Case-insensitive Comparison.
 *
 * The shapes are the portable ones every server of those classes must accept: a property on the left and a literal
 * on the right (`/per/basic-cql2/cql2filter` and `/per/advanced-comparison-operators/*` let a server refuse
 * anything else). With the Property-Property Comparisons class, either side may be a property or a literal (the
 * `Operand…` shapes), with Arithmetic Expressions a number may be computed (the `Arithmetic…` shapes), and Temporal
 * Functions relate instants and intervals (`TemporalPredicate`). `validate`
 * checks a value against them; these types describe what it lets through.
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

// --- Property-Property Comparisons: a property or a literal on either side -------------------------------------

/** A side that reads the features: a property, or `CASEI` / `ACCENTI` of one. */
export type PropertyOperand = StringSubject;

/** A side that is a value: a literal, or a string under `CASEI` / `ACCENTI`. */
export type LiteralOperand = ScalarLiteral | FoldedString;

/** Either side of a comparison, with the Property-Property Comparisons class. */
export type Operand = PropertyOperand | LiteralOperand;

/**
 * A comparison with the Property-Property Comparisons class: a property or a literal on either side
 * (`name = nameascii`, `'København' < name`, `1 = 1`). The sides hold the same type; under `CASEI` / `ACCENTI`,
 * strings.
 */
export interface OperandComparison {
  readonly op: ComparisonOperator;
  readonly args: readonly [Operand, Operand];
}

/** `LIKE` with a string literal on the left (`'København' LIKE 'K_benhavn'`); the pattern is always a literal. */
export interface OperandLike {
  readonly op: "like";
  readonly args: readonly [Operand, string | FoldedString];
}

/** `BETWEEN` with a property or a number in each place (`pop_other BETWEEN pop_min AND pop_max`). */
export interface OperandBetween {
  readonly op: "between";
  readonly args: readonly [PropertyRef | number, PropertyRef | number, PropertyRef | number];
}

/** `IN` with a property or a literal on the left, and properties among the items (`x IN (a, 3)`). */
export interface OperandIn {
  readonly op: "in";
  readonly args: readonly [Operand, readonly Operand[]];
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

// --- Spatial (the classes Basic Spatial Functions, … with additional Spatial Literals, and Spatial Functions) -------

/** A position: longitude, latitude (CRS84) and optionally a height. */
export type Position = readonly [number, number] | readonly [number, number, number];

/**
 * GeoJSON geometries (RFC 7946), as CQL2-JSON writes geometry literals. Without GeoJSON's own `bbox` member: CQL2's
 * schema would read such an object as a bbox literal too.
 */
export interface PointGeometry {
  readonly type: "Point";
  readonly coordinates: Position;
}
export interface LineStringGeometry {
  readonly type: "LineString";
  readonly coordinates: readonly Position[];
}
export interface PolygonGeometry {
  readonly type: "Polygon";
  /** The outer ring, then the holes; each ring closed (its last position equals its first). */
  readonly coordinates: readonly (readonly Position[])[];
}
export interface MultiPointGeometry {
  readonly type: "MultiPoint";
  readonly coordinates: readonly Position[];
}
export interface MultiLineStringGeometry {
  readonly type: "MultiLineString";
  readonly coordinates: readonly (readonly Position[])[];
}
export interface MultiPolygonGeometry {
  readonly type: "MultiPolygon";
  readonly coordinates: readonly (readonly (readonly Position[])[])[];
}
/** Two or more geometries, none of them a collection. */
export interface GeometryCollectionGeometry {
  readonly type: "GeometryCollection";
  readonly geometries: readonly Exclude<Geometry, GeometryCollectionGeometry>[];
}
export type Geometry =
  | PointGeometry
  | LineStringGeometry
  | PolygonGeometry
  | MultiPointGeometry
  | MultiLineStringGeometry
  | MultiPolygonGeometry
  | GeometryCollectionGeometry;

/**
 * `{ "bbox": [west, south, east, north] }`, or with heights `[west, south, min, east, north, max]`. West greater than
 * east is a box across the antimeridian.
 */
export interface BboxLiteral {
  readonly bbox: readonly [number, number, number, number] | readonly [number, number, number, number, number, number];
}

export type SpatialLiteral = Geometry | BboxLiteral;

export type SpatialOperator =
  | "s_intersects" | "s_equals" | "s_disjoint" | "s_touches" | "s_within" | "s_overlaps" | "s_crosses" | "s_contains";

/** `S_INTERSECTS(property, literal)` and the other spatial relations: a geometry property, a geometry literal. */
export interface SpatialPredicate {
  readonly op: SpatialOperator;
  readonly args: readonly [PropertyRef, SpatialLiteral];
}

// --- Arithmetic Expressions: a number computed from numbers and properties ---------------------------------------

export type ArithmeticOperator = "+" | "-" | "*" | "/" | "%" | "div" | "^";

/**
 * An arithmetic expression (the Arithmetic Expressions class): `{ "op": "*", "args": [{ "property": "pop" }, 0.001] }`.
 * Computed with doubles; `div` is the quotient rounded toward zero, `%` its remainder; a result that isn't a finite
 * number (division by zero, overflow) is NULL.
 */
export interface ArithmeticExpression {
  readonly op: ArithmeticOperator;
  readonly args: readonly [NumericOperand, NumericOperand];
}

/** What an arithmetic expression computes from: a number, a property, or another expression. */
export type NumericOperand = number | PropertyRef | ArithmeticExpression;

/** A side of a comparison that may be an arithmetic expression. */
export type ArithmeticOperand = Operand | ArithmeticExpression;

/** A comparison with an arithmetic expression on either side (`area > population * 0.001`). */
export interface ArithmeticComparison {
  readonly op: ComparisonOperator;
  readonly args: readonly [ArithmeticOperand, ArithmeticOperand];
}

/** `BETWEEN` with arithmetic expressions in its places. */
export interface ArithmeticBetween {
  readonly op: "between";
  readonly args: readonly [NumericOperand, NumericOperand, NumericOperand];
}

/** `IN` with arithmetic expressions on the left or among the items. */
export interface ArithmeticIn {
  readonly op: "in";
  readonly args: readonly [ArithmeticOperand, readonly ArithmeticOperand[]];
}

/**
 * A spatial relation with the Property-Property Comparisons class: a geometry property or a literal in either place
 * (`S_WITHIN(BBOX(7,50,8,51), geom)`, two geometry properties, two literals).
 */
export interface OperandSpatialPredicate {
  readonly op: SpatialOperator;
  readonly args: readonly [PropertyRef | SpatialLiteral, PropertyRef | SpatialLiteral];
}

// --- Temporal Functions: how two instants or intervals relate ------------------------------------------------------

export type TemporalOperator =
  | "t_after" | "t_before" | "t_contains" | "t_disjoint" | "t_during" | "t_equals" | "t_finishedBy" | "t_finishes"
  | "t_intersects" | "t_meets" | "t_metBy" | "t_overlappedBy" | "t_overlaps" | "t_startedBy" | "t_starts";

/** An end of an interval: a date `"YYYY-MM-DD"`, a timestamp `"YYYY-MM-DDThh:mm:ss[.fff]Z"`, `".."` (unbounded), or a property. */
export type IntervalEnd = string | PropertyRef;

/** `{ "interval": [start, end] }`: closed at both ends, which are both dates or both timestamps (or `".."`). */
export interface IntervalLiteral {
  readonly interval: readonly [IntervalEnd, IntervalEnd];
}

/** What a temporal function relates: an instant (a date, a timestamp, a property holding one) or an interval. */
export type TemporalOperand = PropertyRef | InstantLiteral | IntervalLiteral;

/**
 * `T_DURING(INTERVAL(start, end), INTERVAL('2022-01-01', '2022-12-31'))` and the other relations of OWL-Time. The
 * relations of intervals only (T_CONTAINS … T_STARTS) take two intervals; T_AFTER, T_BEFORE, T_DISJOINT, T_EQUALS and
 * T_INTERSECTS instants too. A literal first, or a property second, needs the Property-Property Comparisons class.
 */
export interface TemporalPredicate {
  readonly op: TemporalOperator;
  readonly args: readonly [TemporalOperand, TemporalOperand];
}

/** A CQL2-JSON filter in the profile. `true` and `false` are filters too: all features, or none. */
export type Cql2Filter =
  | boolean
  | Comparison
  | Like
  | Between
  | In
  | IsNull
  | SpatialPredicate
  | AndOr
  | Not
  | OperandComparison
  | OperandLike
  | OperandBetween
  | OperandIn
  | OperandSpatialPredicate
  | ArithmeticComparison
  | ArithmeticBetween
  | ArithmeticIn
  | TemporalPredicate;
