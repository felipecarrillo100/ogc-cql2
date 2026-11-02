# Filtering in memory

[Developer guide](index.md) › Filtering in memory

`ogc-cql2/evaluate` tests features against a filter in memory, with CQL2's three-valued logic, so it selects the
same features a CQL2 server would: on a map, in a list, or in Node.

```js
import { toPredicate } from "ogc-cql2/evaluate";

const selected = features.filter(toPredicate(filter));
```

- **`toPredicate(filter)`** gives `(feature) => boolean`, compiled once: use it as a layer's filter function, or to
  select, count or copy features.
- **`toEvaluator(filter)`** gives the three-valued result, `true`, `false` or `null` (unknown).
- **`evaluate(filter, feature)`** is the one-off form.

Each takes the same options as its last argument, and throws `invalid-filter` for a value that isn't a valid filter,
and `unsupported` for a class it can't evaluate with those options (see
[below](#the-classes-evaluate-supports)).

## Your features

Features are read as GeoJSON, `feature.properties[name]`. For another shape, pass
`{ getProperty: (feature, name) => … }`:

```js
const byName = toPredicate(filter, { getProperty: (row, name) => row[name] }); // plain objects
```

`geometryProperty` (default `"geometry"`) names the property that means `feature.geometry`; any other property in a
spatial filter is read with `getProperty` and must hold a GeoJSON geometry.

## The rules

The rules are the standard's:
- **NULL:** a comparison, `LIKE`, `BETWEEN` or `IN` on a null or missing value is unknown. Unknown never selects, and
  neither does its `NOT`. `isNull` is never unknown.
- **Types:** both sides of a comparison must have the same type. A number property compared with the string `"5"`,
  or a non-number in `BETWEEN`, is unknown: values are never converted. NaN, which only `getProperty` can give (JSON
  has none, and CQL2 defines none), is equal to itself and greater than every other number, as PostgreSQL and DuckDB
  order it.
- **Dates and timestamps:** `{ "date" }` matches a `"YYYY-MM-DD"` string or a `Date`; `{ "timestamp" }` an ISO 8601
  string with `Z` or an offset, or a `Date`. Values are read strictly, the same in every engine: the day must exist
  (no 30 February), hours are 00–23, minutes and seconds 00–59, and a fraction counts to the millisecond. A leap second
  in a filter is refused (`invalid-timestamp`): no engine can compare it.
- **Strings** are compared after Unicode normalization (NFC). **`casei`** applies Unicode's full case folding, so
  `"Straße"` matches `"STRASSE"`; it folds exactly what it wraps.
- **`accenti`** removes accents, as the standard defines it: the nonspacing marks after canonical decomposition, so
  `"São Paulo"` matches `"Sao Paulo"` and `"Bogotá"` `"Bogota"`. Put it on both sides, and combine it with `casei` to
  ignore case too:

  ```js
  { op: "=", args: [
    { op: "casei", args: [{ op: "accenti", args: [{ property: "city" }] }] },
    { op: "casei", args: [{ op: "accenti", args: ["SAO PAULO"] }] },
  ] }
  ```

  Following the standard exactly: `ñ` loses its tilde (`año` matches `ano`); `ł`, `ø` and `đ` are letters of their
  own and stay (`Łódź` becomes `Łodz`); the Japanese voicing marks stay (`はじめ` is not `はしめ`), and so do the
  spacing vowel signs of Indic scripts.

`evaluate` doesn't check types against queryables (that is `validate`'s job): a mismatch is NULL, as above.

## Two properties: pass the queryables

Where two properties are compared with each other, no literal says what kind of value they hold. Pass the
collection's queryables, the same object `validate` takes:

```js
const later = toPredicate({ op: ">", args: [{ property: "updated" }, { property: "created" }] }, { queryables });
```

A property with `format: "date"` or `"date-time"` is then read as a day or an instant, as against a date or timestamp
literal. Without them, two properties compare by their values' types: strings as strings (exact for `YYYY-MM-DD`
dates, and for UTC instants written alike), numbers, booleans, `Date`s as instants. Under `casei` / `accenti`, as
strings. More in [Comparing two properties](property-property-and-arithmetic.md).

## Spatial filters, and a geometry engine

`s_intersects` (Basic Spatial Functions, with any geometry) works out of the box, on each feature's `geometry`. The
Spatial Functions class (`s_disjoint`, `s_within`, `s_touches`, …) needs a geometry engine you plug in with
`spatialEngine`, GEOS through geos.js for one. How, and the rules: [Spatial filters](spatial.md#in-memory).

## The classes `evaluate` supports

`evaluateConformance(options)` returns the conformance classes `evaluate`, `toEvaluator` and `toPredicate` support
with those options, as URIs, the way a server declares them. Pass it the same options you pass `toPredicate`:

```js
import { evaluateConformance, toPredicate } from "ogc-cql2/evaluate";
import { validate } from "ogc-cql2/validate";

const options = { spatialEngine: geos }; // or {} for none
const conformance = evaluateConformance(options);

const result = validate(filter, { conformance, queryables });
if (result.valid) layer.filter = toPredicate(filter, options); // never `unsupported`
else showProblems(result.problems); // `needs-conformance` names the class that's missing
```

- **Without `spatialEngine`:** every class the package implements but Spatial Functions. **With one:** every class.
- **The promise:** a filter `validate` accepts against that list is never refused as `unsupported` with the same
  options. One it refuses as `needs-conformance` would be.
- **The list grows** with minor versions, as the package implements classes, so an application that passes it to
  `validate` accepts a new class exactly when its engine supports it. Nothing to update by hand.
- **It is a plain new array,** in `CONFORMANCE`'s order: add or remove classes before passing it on, to hide
  operators from a UI, say.
- **It says what the package evaluates,** not whether a plugged-in engine answers correctly: that is the engine's
  business (GEOS, through geos.js, is the one tested).

The same list drives a filter UI: [offering only what an engine supports](validating-and-filter-uis.md#offering-only-what-is-supported).
