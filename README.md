# ogc-cql2

OGC **CQL2 1.0.0**, the Common Query Language ([OGC 21-065r2](https://docs.ogc.org/is/21-065r2/21-065r2.html)), for
JavaScript and TypeScript. It works on filters in the standard's JSON encoding, **CQL2-JSON**:

- **`ogc-cql2/validate`** checks a filter, with a code, a location and a reason for each problem;
- **`ogc-cql2/text`** writes it as CQL2-text, for the `filter` parameter of OGC API Features Part 3;
- **`ogc-cql2/evaluate`** tests features against it in memory, with CQL2's three-valued logic, so it selects the
  same features a CQL2 server would;
- **`ogc-cql2/sql`** turns it into a parameterized `WHERE` clause for SQLite / GeoPackage, PostgreSQL / PostGIS or
  DuckDB (GeoParquet and other files, in Node and in the browser) that selects exactly what `evaluate` selects. It
  builds the SQL; your own driver runs it.

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
`unknown-operator`, `outside-profile`, `type-mismatch`, `mixed-list`, `invalid-date`, `invalid-timestamp`,
`unknown-property`.

To check a filter against what a server declares, pass its conformance classes. A class the filter needs but the
server lacks is reported as `needs-conformance`:

```js
import { CONFORMANCE } from "ogc-cql2";
import { requiredConformance, validate } from "ogc-cql2/validate";

validate(filter, { conformance: [CONFORMANCE.basic] });
requiredConformance(filter); // the classes the filter uses
```

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
| `"type": "string"` | strings, `casei(…)`; LIKE |
| `"type": "string"`, `"format": "date"` | `{ "date": … }` |
| `"type": "string"`, `"format": "date-time"` | `{ "timestamp": … }` |
| `"type": "number"` or `"integer"` | numbers; BETWEEN |
| `"type": "boolean"` | `true`, `false` |
| another type, or a geometry (`"format": "geometry-…"`) | nothing: only `isNull` |
| no `type` | anything |

`assertValid(value)` returns the filter or throws. `filterProperties(filter)` lists the property names a filter uses.

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
  string with `Z` or an offset, or a `Date`. Values are read strictly, the same in every engine: the day must exist
  (no 30 February), hours are 00–23, minutes and seconds 00–59, and a fraction counts to the millisecond. A leap second
  in a filter is refused (`invalid-timestamp`): no engine can compare it.
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

## SQL (PostgreSQL)

The `postgres` dialect gives the same exact results on PostgreSQL (and PostGIS tables), with `$1`, `$2` … placeholders:

```js
import pg from "pg";
import { postgresFunctions, postgresValue, toSql } from "ogc-cql2/sql";

const client = new pg.Client(); // the connection from PGHOST, PGDATABASE, PGUSER, PGPASSWORD…
await client.connect();
await client.query(postgresFunctions("myschema")); // once: creates cql2_casei, cql2_day, cql2_instant there

const columns = {
  name: { type: "string", sqlType: "text" },
  opened: { type: "string", format: "date-time", sqlType: "timestamp with time zone" },
};
const { where, params } = toSql(filter, { dialect: "postgres", columns, functionSchema: "myschema" });
const select = Object.entries(columns).map(([name, c]) => `${postgresValue(name, c)} AS "${name}"`).join(", ");
const { rows } = await client.query(`SELECT ${select} FROM myschema.places WHERE ${where}`, params);
```

- **`sqlType`** is the column's declared PostgreSQL type; it decides how the column is compared.
- **Text compares in code point order** (`COLLATE "C"`) after NFC normalization: the database's own collation sorts by
  language rules, which CQL2 doesn't.
- **`postgresFunctions(schema)`** returns the SQL to run once: Unicode full case folding for CASEI (PostgreSQL's
  `lower()` isn't), and strict readers of dates and instants in text columns. It needs no extension, only the right to
  create objects in that schema.
- **`postgresValue(column)`** is what to SELECT for each column, so that what you serve is exactly what the SQL
  compared: dates as `YYYY-MM-DD`, instants as UTC `…Z` with milliseconds, numbers as double precision.
- **Tested on real databases:** thousands of generated filters give the same features from a GeoJSON file
  (`evaluate`), a GeoPackage (SQLite) and PostgreSQL / PostGIS.

## SQL (DuckDB)

The `duckdb` dialect runs on DuckDB tables and straight on files, GeoParquet among them, with `$1`, `$2` …
placeholders. **The same SQL works in Node (`@duckdb/node-api`) and in the browser (`@duckdb/duckdb-wasm`)**, so a web
page can filter a large file locally with the filters it sends to servers.

```js
import { duckdbFunctions, duckdbValue, toSql } from "ogc-cql2/sql";

const columns = {
  name: { type: "string", sqlType: "VARCHAR" },
  opened: { type: "string", format: "date-time", sqlType: "TIMESTAMP WITH TIME ZONE" },
};
const { where, params } = toSql(filter, { dialect: "duckdb", columns });
const select = Object.entries(columns).map(([name, c]) => `${duckdbValue(name, c)} AS "${name}"`).join(", ");
const sql = `SELECT ${select} FROM 'places.parquet' WHERE ${where}`;
```

Register `duckdbFunctions` on the connection first (CASEI, and dates or instants held in text, use them). In Node:

```js
import { DuckDBInstance, DuckDBScalarFunction, INTEGER, VARCHAR } from "@duckdb/node-api";

const connection = await (await DuckDBInstance.create()).connect();
const types = { VARCHAR, INTEGER };
for (const [name, f] of Object.entries(duckdbFunctions)) {
  connection.registerScalarFunction(DuckDBScalarFunction.create({
    name,
    returnType: types[f.returns],
    parameterTypes: f.parameters.map((t) => types[t]),
    mainFunction: (info, input, output) => {
      const args = f.parameters.map((_, i) => input.getColumnVector(i));
      for (let row = 0; row < input.rowCount; row++) output.setItem(row, f.call(...args.map((a) => a.getItem(row))));
      output.flush();
    },
  }));
}
const rows = (await connection.runAndReadAll(sql, params)).getRowObjects();
```

In the browser, DuckDB-WASM registers JavaScript functions only in its synchronous ("blocking") build, which belongs
in a Web Worker. That build isn't listed in its package's `exports`, so give it an alias; with Vite:

```js
// vite.config.js
import { fileURLToPath } from "node:url";
export default {
  resolve: {
    alias: {
      "duckdb-wasm-blocking": fileURLToPath(
        new URL("./node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking.mjs", import.meta.url),
      ),
    },
  },
  worker: { format: "es" },
};
```

```js
// worker.js, started with new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
import * as duckdb from "duckdb-wasm-blocking";
import * as arrow from "apache-arrow";
import mvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import { duckdbFunctions, toSql } from "ogc-cql2/sql";

// No top-level await: Vite's default browser targets refuse it.
async function open() {
  const bundles = { mvp: { mainModule: mvp, mainWorker: "" }, eh: { mainModule: eh, mainWorker: "" } };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.BROWSER_RUNTIME);
  await db.instantiate();
  db.open({});
  const connection = db.connect();
  for (const [name, f] of Object.entries(duckdbFunctions)) {
    connection.createScalarFunction(name, new arrow.Int32(), (...args) => f.call(...args));
  }
  return { db, connection };
}

open().then(({ db, connection }) => {
  db.registerFileURL("places.parquet", url, duckdb.DuckDBDataProtocol.HTTP, false); // read by byte ranges
  const rows = connection.prepare(sql).query(...params).toArray().map((row) => row.toJSON());
});
```

- **`sqlType`** is the column's type as `DESCRIBE` gives it.
- **Text compares in code point order** (`COLLATE "binary"`) after NFC normalization, whatever the database's
  `default_collation`.
- **Instants compare as epoch milliseconds,** so the time-zone setting changes nothing.
- **`duckdbFunctions` all return 32-bit integers:** DuckDB-WASM (1.32.0) returns text, DOUBLE and BIGINT results of a
  JavaScript function wrongly, so the functions avoid them, and work the same in both runtimes.
- **`duckdbValue(column)`** is what to SELECT for each column, as `postgresValue` is for PostgreSQL. A GeoParquet
  geometry is read with `geom::BLOB`, which is WKB.
- **Tested in both runtimes:** 11,050 generated filters on a table of awkward values select the same rows as
  `evaluate` in DuckDB (Node) and in DuckDB-WASM (Chrome), also with a `nocase` default collation and another time
  zone. Tested with `@duckdb/node-api` 2.0.0 and `@duckdb/duckdb-wasm` 1.32.0.

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

Every refusal throws a `Cql2Error` with a `code`, a `path` and `details`: `invalid-filter` (not a valid filter in the
profile), `not-expressible` (`toText`: valid, but CQL2-text can't write it) or `unknown-property` (`toSql`: a property
that isn't one of the table's columns).
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
`gpkg_contents`. A **PostgreSQL** entry serves the tables it lists, from the database in `demo-server/.env`
(copy `.env_sample`), filtered with the `postgres` dialect. The samples: the states, the census sub-regions and a
"kitchen sink" of every type and edge case, the same rows in every source (`demo-server/data/README.md` says how to load
them into PostgreSQL). Its routes:

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
- [docs/spatial-research.md](docs/spatial-research.md): spatial support: the standard, the engines measured, the decisions.
- [docs/accent-research.md](docs/accent-research.md): accent-insensitive comparison: the standard, the engines, the decisions.
- [docs/duckdb-case.md](docs/duckdb-case.md): why the package has a DuckDB dialect, and what was measured first.
- [CHANGELOG.md](CHANGELOG.md)

## Licence

MIT, © 2026 Felipe Carrillo Romero. The case-folding table is derived from Unicode data, under the Unicode License:
see [LICENSE-UNICODE](LICENSE-UNICODE).
