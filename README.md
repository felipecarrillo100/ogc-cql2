# ogc-cql2

OGC **CQL2 1.0.0**, the Common Query Language ([OGC 21-065r2](https://docs.ogc.org/is/21-065r2/21-065r2.html)), for
JavaScript and TypeScript. It works on filters in the standard's JSON encoding, **CQL2-JSON**:

- **`ogc-cql2/validate`** checks a filter, with a code, a location and a reason for each problem;
- **`ogc-cql2/text`** writes it as CQL2-text, for the `filter` parameter of OGC API Features Part 3;
- **`ogc-cql2/evaluate`** tests features against it in memory, with CQL2's three-valued logic, so it selects the
  same features a CQL2 server would.

It runs in browsers and in Node 20 or later and has no dependencies. Each part is its own entry point, so an
application loads only what it uses.

```sh
npm install ogc-cql2
```

## What it covers

The package implements these conformance classes, completely:

| Conformance class | Operators |
|---|---|
| Basic CQL2 | `=` `<>` `<` `<=` `>` `>=`, `isNull`, `and` `or` `not`, `true` / `false`, `{ "date" }` and `{ "timestamp" }` literals |
| Advanced Comparison Operators | `like`, `between`, `in` |
| Case-insensitive Comparison | `casei` |

It accepts the form every server of those classes must support: a property on the left, a literal on the right.
Anything else that is valid CQL2 (spatial, temporal and array functions, arithmetic, `accenti`, comparing two
properties, custom functions) is refused as `outside-profile`, with the conformance class it would need. More classes
will follow.

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
`unknown-operator`, `outside-profile`, `type-mismatch`, `mixed-list`, `invalid-date`, `invalid-timestamp`.

To check a filter against what a server declares, pass its conformance classes. A class the filter needs but the
server lacks is reported as `needs-conformance`:

```js
import { CONFORMANCE } from "ogc-cql2";
import { requiredConformance, validate } from "ogc-cql2/validate";

validate(filter, { conformance: [CONFORMANCE.basic] });
requiredConformance(filter); // the classes the filter uses
```

`assertValid(value)` returns the filter or throws. `filterProperties(filter)` lists the property names a filter uses,
for example to check them against a collection's queryables.

## Write CQL2-text

```js
import { toText } from "ogc-cql2/text";

toText(filter);
// "(population > 1000000) AND (CASEI(name) LIKE CASEI('s%'))"

const url = `${collection}/items?filter-lang=cql2-text&filter=${encodeURIComponent(toText(filter))}`;
```

The text follows the standard's grammar exactly: keywords used as property names are quoted, quotes in strings are
doubled, numbers use the grammar's exponent `E`. What the text encoding can't express is refused, never approximated:
a property name that isn't a CQL2 identifier, or a backslash in a string. `textProblem(filter)` reports it without
throwing.

## Evaluate

```js
import { toPredicate } from "ogc-cql2/evaluate";

const selected = features.filter(toPredicate(filter));
```

- **`toPredicate(filter)`** gives `(feature) => boolean`, compiled once: use it as a layer's filter function, or to
  select, count or copy features.
- **`toEvaluator(filter)`** gives the three-valued result, `true`, `false` or `null` (unknown).
- **`evaluate(filter, feature)`** is the one-off form.

Features are read as GeoJSON, `feature.properties[name]`. For another shape, pass
`{ getProperty: (feature, name) => … }`.

The rules are the standard's:
- **NULL:** a comparison, `LIKE`, `BETWEEN` or `IN` on a null or missing value is unknown. Unknown never selects, and
  neither does its `NOT`. `isNull` is never unknown.
- **Types:** both sides of a comparison must have the same type. A number property compared with the string `"5"`,
  or a non-number in `BETWEEN`, is unknown: values are never converted.
- **Dates and timestamps:** `{ "date" }` matches a `"YYYY-MM-DD"` string or a `Date`; `{ "timestamp" }` an ISO 8601
  string with `Z` or an offset, or a `Date`.
- **Strings** are compared after Unicode normalization (NFC). **`casei`** applies Unicode's full case folding, so
  `"Straße"` matches `"STRASSE"`; it folds exactly what it wraps.

## SQL (SQLite)

`ogc-cql2/sql` turns a filter into a parameterized `WHERE` clause. It only builds the text and the values; your code
runs them with its own driver, so the package still has no dependencies.

```js
import { DatabaseSync } from "node:sqlite";
import { sqliteFunctions, toSql } from "ogc-cql2/sql";

const db = new DatabaseSync("data.gpkg");
for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn);

const columns = { name: { type: "string" }, population: { type: "integer" } }; // the table's queryables
const { where, params } = toSql(filter, { dialect: "sqlite", columns });
const rows = db.prepare(`SELECT * FROM places WHERE ${where}`).all(...params);
```

- **Exactly what `evaluate` selects.** The SQL follows the same rules, NULL, no type conversion, NFC, CASEI's case
  folding, case-sensitive LIKE, and the tests check that on a real SQLite database.
- **Columns follow GeoPackage** (OGC 12-128r19), OGC's standard for data in SQLite: give each column's type as its
  queryable (`BOOLEAN` → `boolean`, `INTEGER` → `integer`, `DOUBLE` → `number`, `TEXT` → `string`, `DATE` → `string`
  with `format: "date"`, `DATETIME` → `string` with `format: "date-time"`). BOOLEAN is GeoPackage's 0 / 1, so read
  those values back as `false` / `true`.
- **Register `sqliteFunctions` on the connection.** They run the package's own text, case-folding, LIKE and date-time
  rules inside SQLite, whose built-in LIKE ignores ASCII case and whose `lower()` folds ASCII only.
- **Safe by construction:** values are always `?` parameters, and a property that isn't in `columns` is refused
  (`unknown-property`), so no name reaches the SQL unchecked.
- **The cost of exactness:** SQLite can't use an index for these predicates, because each value's type is checked as
  it is read (GeoPackage tells readers to allow for values of an unexpected type).

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

## Errors

Every refusal throws a `Cql2Error` with a `code` (`invalid-filter` or `not-expressible`), a `path` and `details`.
Test `error.code`, not `instanceof`: that keeps working when two copies of the package end up in one application.

## Playground and demo server

In a clone of the repository:

- **`npm run demo`** opens a page where you type CQL2-JSON and see the problems, the conformance classes, the
  CQL2-text and which sample features match.
- **`demo-server/`** is a small Node backend (Express) that answers the same filters from data files, so the page can
  query a server instead of filtering in the browser. Start it with `npm install && npm start` in `demo-server/`
  (it listens on port 3100; `PORT=… npm start` for another), keep that terminal open, run `npm run demo` in a second
  one, and choose a server collection under "Data" in the page. For a server on another port, start the page with
  `DEMO_SERVER=http://localhost:… npm run demo`.

The server's collections are listed in `demo-server/collections.json`. A collection is either a GeoJSON
FeatureCollection file, filtered in memory with `ogc-cql2/evaluate`, or a table of a **GeoPackage** (OGC's SQLite
format), filtered in the database with `ogc-cql2/sql`: one entry serves every table the GeoPackage lists in
`gpkg_contents`. The sample `usa.gpkg` holds the states and the census sub-regions. PostgreSQL will follow. Its routes:

| Route | Answer |
|---|---|
| `GET /collections` | the collections |
| `GET /collections/{id}/queryables` | the properties and their types (a JSON Schema) |
| `POST /collections/{id}/query` with `{ "filter": …, "limit": 50, "offset": 0 }` | the matching features, as GeoJSON |

An invalid filter, or one naming a property the collection doesn't have, is refused with HTTP 400 and the problems as
`application/problem+json`. Neither the page nor the server is part of the npm package.

## More

- [docs/vision.md](docs/vision.md): what the package is for, and its principles.
- [docs/architecture.md](docs/architecture.md): how it is built and tested.
- [CHANGELOG.md](CHANGELOG.md)

## Licence

MIT, © 2026 Felipe Carrillo Romero. The case-folding table is derived from Unicode data, under the Unicode License:
see [LICENSE-UNICODE](LICENSE-UNICODE).
