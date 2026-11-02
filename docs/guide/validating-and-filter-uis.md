# Validating filters and building filter UIs

[Developer guide](index.md) › Validating filters and building filter UIs

`ogc-cql2/validate` checks a filter before it is sent, evaluated or turned into SQL, with a code, a location and a
reason for each problem.

## Validate

```js
import { validate } from "ogc-cql2/validate";

validate(filter);
// { valid: true, filter }

validate({ op: "=", args: [{ property: "population" }, null] });
// { valid: false, problems: [{
//     code: "wrong-arguments", path: "/args/1",
//     message: "null is not a CQL2 literal. To test for a missing value, use isNull: …" }] }
```

Every problem has a stable `code`, a `path` (a JSON Pointer into the filter) and a `message`. Among the codes:
`unknown-operator`, `outside-profile`, `type-mismatch`, `mixed-list`, `invalid-date`, `invalid-timestamp`,
`unknown-property`, `needs-conformance` (with the class, `problem.conformance`). Test the codes, not the messages.

`assertValid(value)` returns the filter or throws (`invalid-filter`, with the problems in `details.problems`).
`filterProperties(filter)` lists the property names a filter uses.

## Against a server's conformance classes

To check a filter against what a server declares, pass its conformance classes. A class the filter needs but the
server lacks is reported as `needs-conformance`:

```js
import { CONFORMANCE } from "ogc-cql2";
import { requiredConformance, validate } from "ogc-cql2/validate";

const { conformsTo } = await (await fetch(`${api}/conformance`)).json();
validate(filter, { conformance: conformsTo });
validate(filter, { conformance: [CONFORMANCE.basic] });
requiredConformance(filter); // the classes the filter uses
```

Without `conformance`, every class the package implements is allowed, and that set grows with new versions. A server
passes the classes it declares, so an upgrade never accepts a filter the server doesn't serve. For the package's own
engines, the lists come from `evaluateConformance` ([in memory](filtering-in-memory.md#the-classes-evaluate-supports))
and `sqlConformance` ([SQL](sql-backends.md#the-classes-each-dialect-supports)).

## Against a collection's queryables

To check a filter against a collection, pass its **queryables** (OGC API Features Part 3): the `properties` of a
queryables response, as it comes. A property that isn't one of them is `unknown-property`; a literal of another type
than the property's is `type-mismatch`, with a message saying what to write:

```js
const { properties } = await (await fetch(`${collectionUrl}/queryables`)).json();

validate({ op: ">", args: [{ property: "population" }, "10000000"] }, { queryables: properties });
// { valid: false, problems: [{
//     code: "type-mismatch", path: "/args/1",
//     message: '"population" is a number: compare it with a number, e.g. 5 (not "5").' }] }
```

Without queryables, such a filter is valid and simply matches nothing: the value and the literal never compare, so
the comparison is NULL. CQL2 lets a server answer a type mismatch with an error instead (Permission
`/per/basic-cql2/type-casts`), which is what the queryables make possible. A server should validate with them before
filtering; a client can do the same before sending, so that a person or an AI writing the filter learns what is wrong.
`evaluate` and `toSql` don't check types against queryables: they are the engines, and give NULL as before.

| Queryable | Compared with |
|---|---|
| `"type": "string"` | strings, `casei(…)`, `accenti(…)`; LIKE |
| `"type": "string"`, `"format": "date"` | `{ "date": … }` |
| `"type": "string"`, `"format": "date-time"` | `{ "timestamp": … }` |
| `"type": "number"` or `"integer"` | numbers; BETWEEN |
| `"type": "boolean"` | `true`, `false` |
| another type, or a geometry (`"format": "geometry-…"`) | nothing: only `isNull` |
| no `type` | anything |

Both options combine: `validate(filter, { conformance, queryables })`.

## Offering only what is supported

A filter UI should offer the operators of the classes the target supports, and nothing else: a server's
`conformsTo`, or for the package's own engines `evaluateConformance(options)` / `sqlConformance({ dialect })`. Each
operator belongs to one class (the table in [Getting started](getting-started.md#the-conformance-classes)):

```js
import { CONFORMANCE } from "ogc-cql2";
import { evaluateConformance } from "ogc-cql2/evaluate";

const supported = evaluateConformance(); // no spatialEngine: no Spatial Functions
const offer = {
  like: supported.includes(CONFORMANCE.advancedComparison),
  s_intersects: supported.includes(CONFORMANCE.basicSpatial),
  s_within: supported.includes(CONFORMANCE.spatial), // false here
  t_during: supported.includes(CONFORMANCE.temporal),
};
```

Some operators need a second class depending on where their arguments are: a literal on the left, or a property on
the right, also needs Property-Property Comparisons; `s_intersects` with a polygon needs Basic Spatial Functions with
additional Spatial Literals. So also validate what the user built, with the same list: `needs-conformance` names the
class that is missing, and `problem.path` points at the part to change.

```js
const result = validate(built, { conformance: supported, queryables });
const missing = result.valid ? [] : result.problems.filter((p) => p.code === "needs-conformance").map((p) => p.conformance);
```
