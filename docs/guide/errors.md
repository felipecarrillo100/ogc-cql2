# Errors

[Developer guide](index.md) › Errors

`validate` never throws: it returns the problems (see [Validating](validating-and-filter-uis.md)). Every other
refusal throws a `Cql2Error`, from `ogc-cql2`, with a `code`, a `path` (a JSON Pointer into the filter, where it
applies) and `details`:

| Code | Thrown by | Meaning |
|---|---|---|
| `invalid-filter` | `assertValid`, `toText`, `fromText`, `evaluate`, `toSql` | not a valid filter in the profile; `details.problems` lists them, as `validate` would |
| `not-expressible` | `toText` | valid, but CQL2-text can't write it (a property name that isn't an identifier, a backslash in a string…) |
| `invalid-text` | `fromText` | not CQL2-text; `details.position` says where (a JavaScript string index), `details.expected` what could come there |
| `unknown-property` | `toSql` | a property that isn't one of the table's columns |
| `unsupported` | `evaluate`, `toEvaluator`, `toPredicate`, `toSql` | a valid filter of a class there is no engine for with those options: Spatial Functions without `spatialEngine`, or on SQLite without SpatiaLite; `details.conformance` names it |

Test `error.code`, not `instanceof`: that keeps working when two copies of the package end up in one application.

```js
import { toPredicate } from "ogc-cql2/evaluate";

try {
  layer.filter = toPredicate(filter);
} catch (error) {
  if (error.code === "unsupported") console.warn(`needs ${error.details.conformance}`);
  else throw error;
}
```

To avoid `unsupported` altogether, validate first against the engine's own list: `evaluateConformance`
([in memory](filtering-in-memory.md#the-classes-evaluate-supports)) or `sqlConformance`
([SQL](sql-backends.md#the-classes-each-dialect-supports)).

The codes and `details` are stable; the messages aren't (see
[Versioning and stability](../../README.md#versioning-and-stability)).
