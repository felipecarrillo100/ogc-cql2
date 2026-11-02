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

**[Developer guide](docs/guide/index.md)**: how to use each part, task by task, with every rule in detail.

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
| Property-Property Comparisons | a property or a literal on either side: comparisons, `like` (a string on the left), `between`, `in`, the spatial functions | ✅ | ✅ | ✅ |
| Arithmetic Expressions | `+` `-` `*` `/` `%` `div` `^` wherever a number goes | ✅ | ✅ | ✅ |
| Temporal Functions | `t_after` `t_before` `t_disjoint` `t_equals` `t_intersects` `t_contains` `t_during` `t_finishedBy` `t_finishes` `t_meets` `t_metBy` `t_overlappedBy` `t_overlaps` `t_startedBy` `t_starts`, `{ "interval" }` literals | ✅ | ✅ | ✅ |

- **Spatial:** `evaluate` tests `s_intersects` in memory, and the Spatial Functions class (`s_disjoint` and the other
  relations) with a geometry engine you plug in (GEOS in WebAssembly, for one); `sql` translates them for PostGIS,
  DuckDB (with its spatial extension), and SQLite / GeoPackage (`s_intersects` with the package's own functions, the
  Spatial Functions class with SpatiaLite).
- **Property-Property Comparisons:** either side may be a property or a literal (`name = nameascii`,
  `'København' < name`, `S_WITHIN(BBOX(7,50,8,51), geom)`). **Arithmetic:** `area > population * 0.001`.
  **Temporal:** `T_DURING(INTERVAL(start, end), INTERVAL('2023-01-01', '2023-12-31'))`.
- **Each engine says what it supports:** `evaluateConformance(options)` and `sqlConformance(options)` return the
  classes, as conformance URIs, to pass to `validate`; a filter valid against them is never refused as `unsupported`.
- **Anything else that is valid CQL2** (array functions, custom functions) is refused as `outside-profile`, with the
  conformance class it would need. More classes will follow.

## The parts at a glance

A filter is a plain CQL2-JSON value (in TypeScript, `Cql2Filter`, from `ogc-cql2`):

```js
const filter = {
  op: "and",
  args: [
    { op: ">", args: [{ property: "population" }, 1000000] },
    { op: "like", args: [{ op: "casei", args: [{ property: "name" }] }, { op: "casei", args: ["s%"] }] },
  ],
};
```

**Validate** it, against a server's conformance classes and a collection's queryables
([guide](docs/guide/validating-and-filter-uis.md)):

```js
import { validate } from "ogc-cql2/validate";

validate(filter, { conformance: conformsTo, queryables: properties });
// { valid: true, filter }, or { valid: false, problems: [{ code, path, message }, …] }
```

**Write and read CQL2-text** ([guide](docs/guide/cql2-text.md)):

```js
import { toText } from "ogc-cql2/text";
import { fromText } from "ogc-cql2/parse";

toText(filter); // "(population > 1000000) AND (CASEI(name) LIKE CASEI('s%'))"
fromText("population > 1000000 AND CASEI(name) LIKE CASEI('s%')"); // the same filter, as CQL2-JSON
```

**Filter features in memory**, as a CQL2 server would ([guide](docs/guide/filtering-in-memory.md)):

```js
import { evaluateConformance, toPredicate } from "ogc-cql2/evaluate";

const selected = features.filter(toPredicate(filter));
evaluateConformance(); // the classes it supports: all but Spatial Functions, without a geometry engine
```

**Turn it into SQL** that selects exactly what `evaluate` selects ([guide](docs/guide/sql-backends.md)):

```js
import { toSql } from "ogc-cql2/sql";

const columns = { name: { type: "string" }, population: { type: "integer" } }; // the table's queryables
const { where, params } = toSql(filter, { dialect: "sqlite", columns });
// run `SELECT … WHERE ${where}` with params, with your own driver
```

| Database | Dialect | What you get |
|---|---|---|
| SQLite, GeoPackage | `sqlite` | `?` placeholders, GeoPackage's types, its R-tree for spatial filters; Spatial Functions with SpatiaLite ([guide](docs/guide/sqlite-geopackage.md)) |
| PostgreSQL, PostGIS | `postgres` | `$1` placeholders, code point order, PostGIS's GiST index, exact on arm64 too, any SRID ([guide](docs/guide/postgresql.md)) |
| DuckDB, GeoParquet | `duckdb` | the same SQL in Node and in the browser (DuckDB-WASM), straight on files, GeoParquet's bbox covering ([guide](docs/guide/duckdb.md)) |

Every refusal is a `Cql2Error` with a stable `code` ([guide](docs/guide/errors.md)).

## Playground and demo server

In a clone of the repository:

- **`npm run demo`** opens a page where you type CQL2-JSON and see the problems, the conformance classes (ticked as
  the chosen source supports them, from `evaluateConformance` and `sqlConformance`), the CQL2-text and which sample
  features match. Under "Data", the demo's two GeoParquet files can also be filtered in the
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
classes it declares (see the guide's [Validating](docs/guide/validating-and-filter-uis.md)).

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

- [Developer guide](docs/guide/index.md): using the package, task by task.
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
