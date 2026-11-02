# ogc-cql2

[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-ff69b4?style=for-the-badge&logo=github)](https://github.com/sponsors/felipecarrillo100)

OGC **CQL2 1.0.0**, the Common Query Language ([OGC 21-065r2](https://docs.ogc.org/is/21-065r2/21-065r2.html)), for
JavaScript and TypeScript. It works on filters in the standard's JSON encoding, **CQL2-JSON**:

- **`ogc-cql2/validate`** checks a filter, with a code, a location and a reason for each problem;
- **`ogc-cql2/text`** writes it as CQL2-text, for the `filter` parameter of OGC API Features Part 3;
- **`ogc-cql2/parse`** reads CQL2-text into CQL2-JSON, for a server that receives it;
- **`ogc-cql2/evaluate`** tests features against it in memory, with CQL2's three-valued logic, so it selects the
  same features a CQL2 server would;
- **`ogc-cql2/sql`** turns it into a parameterized `WHERE` clause for SQLite / GeoPackage, PostgreSQL / PostGIS or
  DuckDB (GeoParquet and other files, in Node and in the browser) that selects exactly what `evaluate` selects. It
  builds the SQL; your own driver runs it.

It runs in browsers and in Node 22 or later and has no dependencies. Each part is its own entry point, so an
application loads only what it uses.

```sh
npm install ogc-cql2
```

## What it covers

The package implements these conformance classes:

| Conformance class | Operators | `validate`, `text`, `parse` | `evaluate` | `sql` |
|---|---|---|---|---|
| Basic CQL2 | `=` `<>` `<` `<=` `>` `>=`, `isNull`, `and` `or` `not`, `true` / `false`, `{ "date" }` and `{ "timestamp" }` literals | ✅ | ✅ | ✅ |
| Advanced Comparison Operators | `like`, `between`, `in` | ✅ | ✅ | ✅ |
| Case-insensitive Comparison | `casei` | ✅ | ✅ | ✅ |
| Accent-insensitive Comparison | `accenti` | ✅ | ✅ | ✅ |
| Basic Spatial Functions | `s_intersects` with a point or a bbox | ✅ | ✅ | ✅ |
| Basic Spatial Functions with additional Spatial Literals | `s_intersects` with any geometry | ✅ | ✅ | ✅ |
| Spatial Functions | `s_intersects` `s_equals` `s_disjoint` `s_touches` `s_within` `s_overlaps` `s_crosses` `s_contains` | ✅ | ✅ with an engine plugged in | ✅ PostgreSQL, DuckDB; SQLite with SpatiaLite |

Spatial filters can be built, validated and sent to servers (see "Spatial filters" below). `evaluate` tests
`s_intersects` and `s_disjoint` in memory, and the other relations with a geometry engine you plug in (GEOS in
WebAssembly, for one); `sql` translates them for PostGIS and DuckDB (with its spatial extension), and for SQLite and
GeoPackage (`s_intersects` with the package's own functions, the other relations with SpatiaLite). Where an engine is
missing, a filter is refused with the code `unsupported`.

It accepts the form every server of those classes must support: a property on the left, a literal on the right.
Anything else that is valid CQL2 (temporal and array functions, arithmetic, comparing two
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

Without `conformance`, every class the package implements is allowed, and that set grows with new versions. A server
passes the classes it declares, so an upgrade never accepts a filter the server doesn't serve.

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
a property name that isn't a CQL2 identifier, a backslash in a string, or a character a string can't hold (U+0000–U+0006,
U+000E–U+001F, U+FFFE, U+FFFF, a lone surrogate). `textProblem(filter)` reports it without throwing.

## Read CQL2-text

```js
import { fromText } from "ogc-cql2/parse";

fromText("population > 1000000 AND CASEI(name) LIKE CASEI('s%')");
// { op: "and", args: [{ op: ">", args: [{ property: "population" }, 1000000] }, { op: "like", … }] }

// A server: the collection's queryables and its conformance classes, checked in the same call.
const filter = fromText(req.query.filter, { queryables, conformance });
```

`fromText` reads the standard's grammar exactly, every class, then checks the result as `validate` does (with the
same options). So:

- text that isn't CQL2-text throws `invalid-text`, with `details.position` (where, as a JavaScript string index) and
  `details.expected`. Nothing is guessed, and nothing is left unread: `a = 1)` is refused, not read as `a = 1`;
- valid CQL2 outside the profile (temporal functions, arithmetic, …) throws `invalid-filter`, naming the class it
  needs, exactly as the same filter in CQL2-JSON would.

How it reads what the grammar allows in more than one way, or leaves open:

- keywords in any case; a property named like a keyword must be in double quotes (`"date" = 1`; `date = 1` is
  refused, with a hint);
- strings: `''` or `\'` for a quote, and Requirement 21's `\a \b \t \n \v \f \r`; in a LIKE pattern, `\%` and `\_` stay
  as they are; any other backslash is refused;
- `x NOT LIKE …`, `x NOT IN (…)`, `x IS NOT NULL` become `NOT` of the predicate, as in the standard's JSON;
- `-1` is a number; `<>`, `<=`, `>=` may have a space inside (`!=` isn't CQL2);
- geometries: `Z` is optional, the coordinates tell the dimension; `EMPTY` and `MULTIPOINT(1 2, 3 4)` (without each
  point's parentheses) aren't in the grammar and are refused;
- `TIMESTAMP('…')` in UTC, with `Z`, as the grammar writes it.

It reads back exactly what `toText` writes.

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
- **Spatial filters:** give the geometry column as `{ format: "geometry-any", column: "geom" }` (any `geometry-…`
  format). Its values are GeoPackage blobs, or plain WKB; `cql2_intersects` (in `sqliteFunctions`) decides with
  `evaluate`'s own engine, so exactly as `evaluate` does, and a blob's header envelope rejects most rows before the
  geometry is read. With GeoPackage's R-tree, give its table too, `rtree: "rtree_places_geom"`: the candidates then
  come from it (on a million rows, a small box took 3 ms instead of 811 ms). The R-tree holds no NULL or empty
  geometries, so it is used only where that changes no answer, outside a NOT: negate the filter (`{ op: "not" }`),
  never the SQL it gives.
- **The other relations (Spatial Functions) need SpatiaLite:** load `mod_spatialite` on the connection and pass
  `spatialite: true`; GEOS then decides each relation, exactly as `evaluate` with GEOS does. SpatiaLite reads
  GeoPackage blobs itself; anything it can't read (WKB, empty geometries) goes through `cql2_wkt`, the package's own
  reader. The R-tree applies as for `s_intersects`. A GeometryCollection literal needs SpatiaLite built with GEOS 3.13
  or later: with GEOS 3.12 (Ubuntu 24.04's), S_TOUCHES and S_OVERLAPS against a collection of a point and a line
  select other rows than `evaluate`.

  ```js
  const db = new DatabaseSync("places.gpkg", { allowExtension: true });
  db.loadExtension("mod_spatialite"); // its path where the loader doesn't look, e.g. "/opt/homebrew/lib/mod_spatialite"
  const { where, params } = toSql(filter, { dialect: "sqlite", columns, spatialite: true });
  ```

## SQL (PostgreSQL)

The `postgres` dialect gives the same exact results on PostgreSQL (and PostGIS tables), with `$1`, `$2` … placeholders:

```js
import pg from "pg";
import { postgresFunctions, postgresValue, toSql } from "ogc-cql2/sql";

const client = new pg.Client(); // the connection from PGHOST, PGDATABASE, PGUSER, PGPASSWORD…
await client.connect();
await client.query(postgresFunctions("myschema")); // once: creates cql2_casei, cql2_accenti, cql2_day… there

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
  `lower()` isn't), accent removal for ACCENTI (PostgreSQL's `unaccent` extension follows a dictionary instead: it
  turns `ø` into `o`), and strict readers of dates and instants in text columns. It needs no extension, only the right to
  create objects in that schema.
- **Spatial filters (PostGIS):** give the geometry column as `{ sqlType: "geometry", column: "geom" }` (or
  `geometry(MultiPolygon, 4326)`, `geography`). `s_intersects` becomes `geom && literal AND NOT ST_Relate(geom,
  literal, 'FF*FF****')`: the box test uses the GiST index, and GEOS's DE-9IM matrix decides exactly, as `evaluate`
  does. PostGIS's own `ST_Intersects`, and from PostGIS 3.7 `ST_Disjoint`, aren't used: on arm64 machines (Apple
  Silicon, AWS Graviton) they miss a point lying exactly on an edge. A GeometryCollection literal is tested member by
  member, which GEOS 3.11 needs; a column holding GeometryCollections needs GEOS 3.13 or later (3.9 works too).
- **The other relations (Spatial Functions):** `ST_Equals`, and `ST_Touches` / `ST_Overlaps` / `ST_Crosses` behind
  `&&`; `s_within` and `s_contains` as `geom @ literal AND ST_Relate(geom, literal, 'T*F**F***')` and `geom ~ literal
  AND ST_Relate(…, 'T*****FF*')`, since `ST_Within` and `ST_Contains` take the same point-in-polygon shortcut;
  `s_disjoint` as the negation of `s_intersects`. Each uses the GiST index but `s_disjoint`, which no index can
  speed up. A box across the antimeridian is one literal, its two halves collected.
- **Another SRID, or geography:** a column in another SRID (`srid: 3857`, or `geometry(Point, 3857)`) is transformed
  to 4326, so the comparison is planar in CRS84, as CQL2's is; a geography column is read as geometry. Neither can
  use a plain index on the column, so give it an expression index, which the SQL then uses:

  ```sql
  CREATE INDEX ON places USING GIST (ST_Transform(geom, 4326)); -- a column in another SRID
  CREATE INDEX ON places USING GIST ((geog::geometry));          -- a geography column
  ```

  Data stored in another CRS isn't exact on its original vertices any more (5 comes back as 4.999999999999998).
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

Register `duckdbFunctions` on the connection first (CASEI, ACCENTI, and dates or instants held in text, use them).
DuckDB's own `strip_accents` isn't used for ACCENTI: it also strips the spacing vowel signs of Indic scripts and the
Japanese voicing marks (548 code points differ from the standard's rule, measured). In Node:

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
- **Numbers are parameters as text** (`"0.9653517007827759"`, cast to DOUBLE in the SQL): DuckDB-WASM (1.32.0) binds
  about one number in ten that needs all 17 digits one unit off (`0.965351700782776`), and reads text exactly. It
  reads a SQL literal of 17 digits one unit off too, so insert such values as text (`'0.9653517007827759'::DOUBLE`).
- **Spatial filters need the spatial extension** (`INSTALL spatial; LOAD spatial`, in Node and in DuckDB-WASM): give
  the geometry column as `{ sqlType: "GEOMETRY", column: "geom" }`, or a column of WKB as `{ sqlType: "BLOB" }`.
  `s_intersects` becomes `ST_Intersects(geom, literal)`, as DuckDB documents it: exact (the same answers as `evaluate`
  for thousands of literals on vertices and edges), it uses an R-tree index when the table has one, and DuckDB 2.0
  skips row groups by their statistics for it. A box across the antimeridian is one literal, so the index still
  applies. WKB is read with `TRY(ST_GeomFromWKB(…))`: bytes that aren't WKB are NULL, instead of failing the query. No
  JavaScript function stands in without the extension: DuckDB-WASM hands a BLOB to one as text, losing its bytes.
- **GeoParquet's bbox covering** (GeoParquet 1.1): give it as the file's `geo` metadata has it, and the filter compares
  its four fields first, then decides with `ST_Intersects`, as Overture's documentation writes it. That skips row
  groups, and most rows, before the exact test; DuckDB doesn't use a covering by itself. On a 730 MB Overture places
  file read over HTTP with DuckDB 2.0: 1.9 s instead of 18.7 s.

  ```js
  const [[geo]] = (await connection.runAndReadAll(
    "SELECT decode(value) FROM parquet_kv_metadata('places.parquet') WHERE decode(key) = 'geo'")).getRows();
  const { covering } = JSON.parse(geo).columns.geometry; // { bbox: { xmin: ["bbox", "xmin"], … } }, or undefined
  const columns = { geometry: { sqlType: "GEOMETRY", column: "geometry", covering } };
  ```

  The comparisons are used only where the filter isn't negated: negate the filter (`{ op: "not" }`), never the SQL it
  gives (`NOT (…)`). Leave `covering` out for a table with an R-tree index on the geometry: the index is faster on its
  own. DuckDB 1.4 and 1.5 (also in DuckDB-WASM) answer such a query exactly; DuckDB 2.0 fails on it with an internal
  error.
- **The other relations (Spatial Functions):** `ST_Equals`, `ST_Touches`, `ST_Within`, `ST_Overlaps`, `ST_Crosses`,
  `ST_Contains` (exact in DuckDB 1.4, 1.5 and 2.0, each using an R-tree index), with the covering's comparisons first
  as for `s_intersects`; `s_disjoint` as the negation of `s_intersects`.
- **Fast without a covering:** an R-tree index (`CREATE INDEX … USING RTREE (geom)`), or rows sorted spatially
  (`ORDER BY ST_Hilbert(geom, …)`) in moderate row groups, as GeoParquet's guidance recommends. On unsorted data
  without an index, `ST_Intersects` tests every row.
- **`duckdbValue(column)`** is what to SELECT for each column, as `postgresValue` is for PostgreSQL. A GeoParquet
  geometry is read with `geom::BLOB`, which is WKB.
- **Tested in both runtimes:** 24,661 generated filters on a table of awkward values, and 5,705 spatial literals on the
  US states, select the same rows as `evaluate` in DuckDB (Node) and in DuckDB-WASM (Chrome), also with a `nocase`
  default collation and another time zone. Tested with `@duckdb/node-api` 2.0.0 and `@duckdb/duckdb-wasm` 1.32.0; the
  spatial tests also run, in Node, on DuckDB 1.4.3, the engine DuckDB-WASM 1.32.0 ships.

## Spatial filters

A spatial filter is a geometry property, then a geometry literal: a GeoJSON geometry, or a box.

```js
// The map view, as a box: [west, south, east, north] in longitude / latitude.
const inView = { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [5.9, 45.8, 10.5, 47.8] }] };
toText(inView); // "S_INTERSECTS(geometry, BBOX(5.9, 45.8, 10.5, 47.8))"

// A drawn area, as a polygon.
const inArea = { op: "s_within", args: [{ property: "geometry" }, {
  type: "Polygon", coordinates: [[[-80, 40], [-70, 40], [-70, 47], [-80, 47], [-80, 40]]],
}] };
requiredConformance(inArea); // the URIs of Basic CQL2 and Spatial Functions
```

- **The class a server must declare** follows the standard: `s_intersects` with a point or a box is Basic Spatial
  Functions; with any other geometry, Basic plus; any other relation, Spatial Functions. Check it against what a
  server declares with `validate`'s `conformance`.
- **Coordinates are CRS84**, longitude then latitude, as the standard says without `filter-crs`: a longitude outside
  −180…180 or a latitude outside −90…90 is refused (`invalid-geometry`). So is a ring that isn't closed, a
  LineString of one position, or a box with its south above its north.
- **A box across the antimeridian** has its west greater than its east: `[170, -10, -170, 10]`.
- **Heights** are kept: a position of three numbers, a box of six (`[west, south, min, east, north, max]`).
- **With queryables**, the property must be a geometry (`"format": "geometry-…"`, or a `$ref` to a GeoJSON schema).
- **Not accepted:** a geometry literal first (the standard lets servers refuse it, so swap the two), a geometry's own
  GeoJSON `bbox` member (CQL2's schema refuses it), functions such as `Buffer`.

**In memory**, `evaluate` tests `s_intersects` on each feature's `geometry`, as GeoJSON keeps it:

```js
const inView = toPredicate({ op: "s_intersects", args: [{ property: "geometry" }, { bbox: [5, 45, 15, 51] }] });
features.filter(inView); // the features the box touches
```

- **The same answers as GEOS** (PostGIS, SpatiaLite, DuckDB): planar, in the coordinates as given, boundaries
  included (a point on an edge intersects), decided with exact arithmetic. Heights are ignored. A feature without a
  geometry is NULL.
- **`geometryProperty`** (default `"geometry"`) names the property that means `feature.geometry`; any other property
  in a spatial filter is read with `getProperty` and must hold a GeoJSON geometry.
- **Tested** with the standard's own Natural Earth test (Table 12: 8, 10, 1, 3, 5, 10, 7, 4 features), and against
  GEOS on the US states for thousands of generated literals placed exactly on their vertices and edges.

**The other relations in memory** (`s_within`, `s_touches`, …: Spatial Functions) need a planar geometry engine,
which `evaluate` doesn't bundle. Plug one in with `spatialEngine`: it only computes DE-9IM matrices, and the package
decides what each relation means (the standard's patterns, the dimension rules of `s_overlaps` and `s_crosses`), so
every engine gives the same answers. GEOS in WebAssembly, through [geos.js](https://www.npmjs.com/package/geos.js)
(GEOS is LGPL), takes a few lines:

```js
import { fromGeoJSON, initializeFromBase64, prepare, relate } from "geos.js";

await initializeFromBase64(); // once, before the first filter
const geos = {
  prepare(literal) {
    const prepared = prepare(fromGeoJSON(literal)); // once per filter
    return {
      relate(geometry) {
        const g = fromGeoJSON(geometry);
        try { return relate(prepared, g); } finally { g.free(); }
      },
    };
  },
};
features.filter(toPredicate(inArea, { spatialEngine: geos }));
```

- **The engine never sees** NULLs, values that aren't a geometry, or empty geometries; a box comes as a polygon
  (across the antimeridian, a multipolygon). An engine that throws for a feature (an invalid polygon) makes that
  feature NULL.
- **`s_intersects` and `s_disjoint`** keep the package's own exact engine, with or without one plugged in.
- **Tested** with the standard's own Natural Earth test for Spatial Functions (Table 14: all 26 predicates and their
  counts), and against PostGIS on the US states for every relation.

**In SQL**, the three dialects give the same answers as `evaluate`: see "Spatial filters" in the SQLite, PostgreSQL
and DuckDB sections above.

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
profile), `not-expressible` (`toText`: valid, but CQL2-text can't write it), `invalid-text` (`fromText`: not
CQL2-text; `details.position` says where), `unknown-property` (`toSql`: a property that isn't one of the table's
columns) or `unsupported` (`evaluate`, `toSql`: a valid filter of a class there is no engine for, Spatial Functions
without `spatialEngine` or SpatiaLite; `details.conformance` names it).
Test `error.code`, not `instanceof`: that keeps working when two copies of the package end up in one application.

## Playground and demo server

In a clone of the repository:

- **`npm run demo`** opens a page where you type CQL2-JSON and see the problems, the conformance classes, the
  CQL2-text and which sample features match. Under "Data", the demo's two GeoParquet files can also be filtered in the
  page itself, by DuckDB-WASM in a Web Worker, with no server (the engine, about 8 MB compressed, and its spatial
  extension download when one is chosen).
- **`demo-server/`** is a small Node backend (Express) that answers the same filters from data files, so the page can
  query a server instead of filtering in the browser. Start it with `npm install && npm start` in `demo-server/`
  (it listens on port 3100; `PORT=… npm start` for another), keep that terminal open, run `npm run demo` in a second
  one, and choose a server collection under "Data" in the page. For a server on another port, start the page with
  `DEMO_SERVER=http://localhost:… npm run demo`.

The server's collections are listed in `demo-server/collections.json`. A collection is either a GeoJSON
FeatureCollection file, filtered in memory with `ogc-cql2/evaluate`, or a table of a **GeoPackage** (OGC's SQLite
format), filtered in the database with `ogc-cql2/sql`: one entry serves every table the GeoPackage lists in
`gpkg_contents`. A **GeoParquet** (or Parquet) file is read in place by DuckDB (`@duckdb/node-api`), filtered with the
`duckdb` dialect, its bbox covering used when the file has one. A **PostgreSQL** entry serves the tables it lists, from the database in `demo-server/.env`
(copy `.env_sample`), filtered with the `postgres` dialect. The samples: the states, the census sub-regions and a
"kitchen sink" of every type and edge case, the same rows in every source (`demo-server/data/README.md` says how to load
them into PostgreSQL). Its routes:

| Route | Answer |
|---|---|
| `GET /collections` | the collections |
| `GET /collections/{id}/queryables` | the properties and their types (a JSON Schema) |
| `POST /collections/{id}/query` with `{ "filter": …, "limit": 50, "offset": 0 }` | the matching features, as GeoJSON |
| … with `"filter-lang": "cql2-text"` and the filter as a CQL2-text string | the same, read with `ogc-cql2/parse` |

An invalid filter, or one naming a property the collection doesn't have, is refused with HTTP 400 and the problems as
`application/problem+json`. Neither the page nor the server is part of the npm package.

## Versioning and stability

Since 1.0.0 the package follows [semantic versioning](https://semver.org/): a breaking change comes only in a major
version, and something is removed only after a minor version has deprecated it.

**Stable:**
- the entry points and the signatures of their functions;
- the options objects, which only gain optional keys;
- `Cql2Error` (`name`, `code`, `path`, `details`), the meaning of each code, `details.problems` and
  `details.position`;
- `toSql`'s result (`where`, `params`) and each dialect's placeholders;
- the `SpatialEngine` interface;
- `CQL2_CONFORMANCE` (all of CQL2 1.0's filter classes, fixed as the standard is) and each key of `CONFORMANCE`.

**Added in minor versions, as the package grows:**
- filter shapes the standard allows, as a class is implemented: new members of `Cql2Filter`, wider arguments (a
  property on both sides of a comparison, for example);
- new codes in `Cql2ErrorCode`, `ProblemCode` and `TextProblemCode`;
- new keys in `CONFORMANCE`;
- new SQL dialects (`SqlDialect`), keys in `SqlColumn` and the options, and helpers such as `sqliteFunctions`.

So code that reads filters, codes or dialects keeps a default case for what it doesn't know. And `validate`'s default
`conformance` (every implemented class) accepts a newly implemented class after an upgrade: a server passes the
classes it declares (see [Validate](#validate)).

**Not covered:** messages (test the codes), the SQL text itself (what it selects is covered), and anything the entry
points don't export.

## Tested versions

"Tested" means the differential tests (the same answers as `evaluate`, filter by filter) ran on that exact version.
Older versions may well work, but haven't been tested.

| Component | Tested | Notes |
|---|---|---|
| Node.js | 22.23.4, 24.15.0 | 22 or later. `node:sqlite` needs no flag from Node 22.13 |
| Browsers | Chrome 156 | the DuckDB-WASM checks; `fromText` on the standard's text examples |
| PostgreSQL + PostGIS (GEOS) | 13 / 3.1.4 (3.9.0), 15 / 3.3.4 (3.9.0), 16 / 3.4.3 (3.9.0), 17 / 3.5.2 (3.9.0), 18 / 3.6.4 (3.14.1) on amd64; 17 / 3.5.3 (3.11.1), 17.10 / 3.5.6 (3.13.1), 18 / 3.6.1 (3.13.1), 18 / 3.7.0 (3.15.0) on arm64 | the spatial filters on all of them; every other filter on 17.10 / 3.5.6. A column holding GeometryCollections: GEOS 3.13 or later |
| `pg` (node-postgres) | 8.23.1 | |
| SQLite (`node:sqlite`) | 3.51.3 (Node 24.15), 3.53.4 (Node 22.23) | GeoPackage 1.4 |
| SpatiaLite | 5.1.0 (GEOS 3.15.0, 3.14.1) | for Spatial Functions in `sqlite`; GEOS 3.13 or later for GeometryCollection literals |
| DuckDB, Node (`@duckdb/node-api`) | 2.0.0, 1.5.4, 1.4.3 | 1.5.4 by `npm run check:duckdb`, which tests the newest releases |
| DuckDB-WASM (`@duckdb/duckdb-wasm`) | 1.32.0 (DuckDB 1.4.3), 1.33.1-dev57.0 (DuckDB 1.5.4) | with the spatial extension |
| geos.js (as `spatialEngine`) | 0.1.5 (GEOS 3.14.0) | |

## More

- [docs/vision.md](docs/vision.md): what the package is for, and its principles.
- [docs/architecture.md](docs/architecture.md): how it is built and tested.
- [docs/spatial-research.md](docs/spatial-research.md): spatial support: the standard, the engines measured, the decisions.
- [docs/accent-research.md](docs/accent-research.md): accent-insensitive comparison: the standard, the engines, the decisions.
- [docs/duckdb-case.md](docs/duckdb-case.md): why the package has a DuckDB dialect, and what was measured first.
- [CHANGELOG.md](CHANGELOG.md)

## Donations & sponsoring

Building and maintaining open-source libraries takes time, and ogc-cql2 is tested against real databases and engines
before every release. If it saves you work, please consider supporting its development: it keeps the project active
and moving forward.

Every bit of support is appreciated, whether it is sponsoring on GitHub, a coffee, a star, or a mention. Thank you
for being part of the community!

[<img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="180">](https://buymeacoffee.com/felipecarrillo100)

[![Sponsor](https://img.shields.io/badge/Sponsor-❤️-ff69b4?style=for-the-badge&logo=github)](https://github.com/sponsors/felipecarrillo100)

[![PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/donate/?business=7X3JAPNBQTXZG&amount=5&no_recurring=0&item_name=NPM%2FGitHub+libraries&currency_code=USD)

[![QR code for PayPal](https://raw.githubusercontent.com/felipecarrillo100/bankgreen/main/QR_Code_5Euro.png)](https://www.paypal.com/donate/?business=7X3JAPNBQTXZG&amount=5&no_recurring=0&item_name=NPM%2FGitHub+libraries&currency_code=USD)

## Licence

MIT, © 2026 Felipe Carrillo Romero. The case-folding table is derived from Unicode data, under the Unicode License:
see [LICENSE-UNICODE](LICENSE-UNICODE).
