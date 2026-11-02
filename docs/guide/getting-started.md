# Getting started

[Developer guide](index.md) › Getting started

## Install

```sh
npm install ogc-cql2
```

It runs in browsers and in Node 22 or later and has no dependencies.

## The entry points

Each part is its own entry point, so an application loads only what it uses:

| Entry point | What it does | Page |
|---|---|---|
| `ogc-cql2` | the types (`Cql2Filter`…), `CONFORMANCE`, `CQL2_CONFORMANCE`, `Cql2Error` | this one |
| `ogc-cql2/validate` | `validate`, `assertValid`, `requiredConformance`, `filterProperties` | [Validating](validating-and-filter-uis.md) |
| `ogc-cql2/text` | `toText`, `textProblem`: CQL2-JSON to CQL2-text | [CQL2-text](cql2-text.md) |
| `ogc-cql2/parse` | `fromText`: CQL2-text to CQL2-JSON | [CQL2-text](cql2-text.md) |
| `ogc-cql2/evaluate` | `toPredicate`, `toEvaluator`, `evaluate`, `evaluateConformance` | [Filtering in memory](filtering-in-memory.md) |
| `ogc-cql2/sql` | `toSql`, `sqlConformance`, each database's helper functions | [SQL backends](sql-backends.md) |

## A filter

A filter is a plain CQL2-JSON value: store it, send it, or pass it to any of the parts.

```js
const filter = {
  op: "and",
  args: [
    { op: ">", args: [{ property: "population" }, 1000000] },
    { op: "like", args: [{ op: "casei", args: [{ property: "name" }] }, { op: "casei", args: ["s%"] }] },
  ],
};
```

In TypeScript, the type is `Cql2Filter`, from `ogc-cql2`.

## The conformance classes

CQL2 groups its operators in conformance classes, and a server declares the ones it supports (its `/conformance`).
The package implements these:

| Conformance class | Operators | `validate`, `text`, `parse` | `evaluate` | `sql` |
|---|---|---|---|---|
| Basic CQL2 | `=` `<>` `<` `<=` `>` `>=`, `isNull`, `and` `or` `not`, `true` / `false`, `{ "date" }` and `{ "timestamp" }` literals | ✅ | ✅ | ✅ |
| Advanced Comparison Operators | `like`, `between`, `in` | ✅ | ✅ | ✅ |
| Case-insensitive Comparison | `casei` | ✅ | ✅ | ✅ |
| Accent-insensitive Comparison | `accenti` | ✅ | ✅ | ✅ |
| Basic Spatial Functions | `s_intersects` with a point or a bbox | ✅ | ✅ | ✅ |
| Basic Spatial Functions with additional Spatial Literals | `s_intersects` with any geometry | ✅ | ✅ | ✅ |
| Spatial Functions | `s_intersects` `s_equals` `s_disjoint` `s_touches` `s_within` `s_overlaps` `s_crosses` `s_contains` | ✅ | ✅ with an engine plugged in | ✅ PostgreSQL, DuckDB; SQLite with SpatiaLite |
| Property-Property Comparisons | a property or a literal on either side: comparisons, `like` (a string on the left), `between`, `in`, the spatial functions | ✅ | ✅ | ✅ |
| Arithmetic Expressions | `+` `-` `*` `/` `%` `div` `^` wherever a number goes | ✅ | ✅ | ✅ |
| Temporal Functions | `t_after` `t_before` `t_disjoint` `t_equals` `t_intersects` `t_contains` `t_during` `t_finishedBy` `t_finishes` `t_meets` `t_metBy` `t_overlappedBy` `t_overlaps` `t_startedBy` `t_starts`, `{ "interval" }` literals | ✅ | ✅ | ✅ |

`CONFORMANCE` (from `ogc-cql2`) holds their URIs, as servers declare them, and grows as classes are implemented;
`CQL2_CONFORMANCE` holds all twelve of the standard's filter classes. In code, ask the engines rather than copying
this table: `evaluateConformance()` and `sqlConformance({ dialect })` return the classes each one supports with its
options (see [Filtering in memory](filtering-in-memory.md#the-classes-evaluate-supports) and
[SQL backends](sql-backends.md#the-classes-each-dialect-supports)).

- **Spatial filters** can be built, validated and sent to servers. `evaluate` tests `s_intersects` in memory, and the
  Spatial Functions class (`s_disjoint` and the other relations) with a geometry engine you plug in (GEOS in
  WebAssembly, for one); `sql` translates them for PostGIS and DuckDB (with its spatial extension), and for SQLite and
  GeoPackage (`s_intersects` with the package's own functions, the Spatial Functions class with SpatiaLite). Where an
  engine is missing, a filter is refused with the code `unsupported`. See [Spatial filters](spatial.md).
- **Every server of those classes must support a property on the left and a literal on the right.** With
  Property-Property Comparisons, either side may be a property or a literal (`name = nameascii`, `'København' < name`,
  `S_WITHIN(BBOX(7,50,8,51), geom)`): a server that doesn't declare that class gets `needs-conformance` for them.
  With Arithmetic Expressions, a number can be computed (`area > population * 0.001`). See
  [Comparing two properties, and arithmetic](property-property-and-arithmetic.md).
- **With Temporal Functions,** instants and intervals relate
  (`T_DURING(INTERVAL(start, end), INTERVAL('2023-01-01', '2023-12-31'))`). See [Temporal filters](temporal.md).
- **Anything else that is valid CQL2** (array functions, custom functions) is refused as `outside-profile`, with the
  conformance class it would need. More classes will follow.

## LIKE patterns

`%` matches any number of characters, `_` exactly one. To match a literal `%` or `_`, write `\%` or `\_`:

```js
{ op: "like", args: [{ property: "code" }, "100\\%"] }   // the text "100%"
```

## No null literal

CQL2 has no `null` literal. A missing value is tested with `isNull`. For "one of these values, or missing", combine
them:

```js
{ op: "or", args: [
  { op: "in", args: [{ property: "country" }, ["CA", "DE"]] },
  { op: "isNull", args: [{ property: "country" }] },
] }
```

## Next

- Filter features in a web page or in Node: [Filtering in memory](filtering-in-memory.md).
- Check filters before sending them, or on a server: [Validating filters](validating-and-filter-uis.md).
- Serve filters from a database: [SQL backends](sql-backends.md).
