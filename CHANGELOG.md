# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor version may change the API.

## [0.2.0] - 2026-10-31

DuckDB: the same CQL2 filters on GeoParquet and other files, in Node and in the browser (DuckDB-WASM). Tested in both:
11,050 generated filters select what `evaluate` selects in `@duckdb/node-api` 2.0.0 and in `@duckdb/duckdb-wasm`
1.32.0 (Chrome).

### Added

- `ogc-cql2/sql`: dialect `duckdb`, the same SQL for `@duckdb/node-api` and `@duckdb/duckdb-wasm`. Text in code point
  order and NFC whatever the database's default collation, instants as epoch milliseconds whatever its time zone,
  DuckDB's own case-sensitive LIKE with `ESCAPE`.
- `duckdbFunctions`: the functions the `duckdb` dialect calls (CASEI, and dates and instants held in text), with their
  DuckDB types, to register on the connection. They return 32-bit integers only, the one result type DuckDB-WASM
  passes back exactly.
- `duckdbValue`: what to SELECT for a column, so that what is served is what the SQL compares.
- Types `SqlValue` and `DuckdbFunction`.

### Changed

- `ogc-cql2/sql` is organized as one walker and one file per dialect (`src/sql/dialects/`). The `sqlite` and
  `postgres` dialects build exactly the same SQL as in 0.1.0.
- `SqlColumn.sqlType` is also read by the `duckdb` dialect (DuckDB's type names, as `DESCRIBE` gives them).
- `@duckdb/node-api` is a development dependency, for the DuckDB differential test; the package still has no runtime
  dependencies.

## [0.1.0] - 2026-10-31

The first working version: the profile Basic CQL2, Advanced Comparison Operators and Case-insensitive Comparison.

### Added

- `ogc-cql2`: the profile's CQL2-JSON types (`Cql2Filter` and one type per operator); `Cql2Error` with a stable
  `code`, a `path` and `details`; `CONFORMANCE`, the profile's conformance classes, and `OTHER_CONFORMANCE`, the
  classes named when a filter is outside the profile.
- `ogc-cql2/validate`: `validate(value, { conformance? })`, every problem with a code, a JSON Pointer and a message;
  `assertValid`; `requiredConformance`; `filterProperties`.
- `ogc-cql2/text`: `toText`, CQL2-JSON to CQL2-text following the released grammar; `textProblem`, what the text
  can't express; `isIdentifier`.
- `ogc-cql2/evaluate`: `toPredicate`, `toEvaluator` and `evaluate`, with CQL2's three-valued logic, Unicode full case
  folding for `casei`, NFC normalization for strings and code point order.
- `ogc-cql2/sql`: `toSql`, a parameterized `WHERE` clause selecting exactly what `evaluate` selects: dialect `sqlite`
  (GeoPackage's types; `sqliteFunctions` to register on the connection) and `postgres` (`postgresFunctions` to create
  once, `postgresValue` for what to select). A property that isn't a column is refused (`Cql2Error`
  `unknown-property`).
- Dates and instants are read strictly in every engine: a day must exist, seconds 00-59.
- The MIT licence, and `LICENSE-UNICODE` for the case-folding table derived from Unicode data.
- The demo is now a playground: a CQL2-JSON filter, its problems, conformance classes, CQL2-text and the sample
  features it selects, in the browser or from `demo-server`.
- `demo-server/` (not published): a Node backend answering filters through a store layer: GeoJSON files, filtered
  with `ogc-cql2/evaluate`; GeoPackage tables, filtered in SQLite; and PostgreSQL / PostGIS tables, both with
  `ogc-cql2/sql`. A kitchen-sink sample holds the same rows in all three, and they answer every generated filter alike.
- `check:imports` and `check:bundle`, run before every publish: the package has no runtime dependencies, and a page
  importing only `ogc-cql2/evaluate` bundles nothing else.

## [0.0.1] - 2026-10-30

The package's foundation, published to claim the name. No filter functions yet.

### Added

- `ogc-cql2`: `CQL2_VERSION`, the version of the standard the package implements (`"1.0.0"`, OGC 21-065r2).
- `ogc-cql2/text`: `quoteString(value)`, a string as a CQL2-text character literal, in single quotes with each quote
  doubled.
- ESM only, with no runtime dependencies. It runs in browsers and in Node 20 or later, with type declarations for each
  entry point.
- A demo page (`npm run demo`), not part of the published package.

[0.2.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.1.0
[0.0.1]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.0.1
