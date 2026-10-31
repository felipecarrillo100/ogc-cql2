# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor version may change the API.

## [0.7.0] - 2026-10-31

Spatial filters, phase B: `evaluate` tests `s_intersects` in memory.

### Added

- `evaluate`: `s_intersects` (Basic Spatial Functions and Basic plus), planar, boundaries included, heights ignored,
  with exact orientation (Shewchuk's `orient2d`, public domain, copied in), so a point exactly on an edge is decided
  as GEOS decides it. A box across the antimeridian is two boxes. A feature without a geometry, or with something that
  isn't a GeoJSON geometry, is NULL.
- `EvaluateOptions.geometryProperty` (default `"geometry"`): the property that means `feature.geometry`.

### Changed

- `evaluate` no longer refuses Basic Spatial Functions and Basic plus; Spatial Functions (`s_within` and the other
  relations) and spatial SQL stay `unsupported`.

### Tests

- The standard's Natural Earth acceptance test (Table 12): all eight counts.
- Against GEOS (through PostGIS) on the US states: 5,705 generated literals, many exactly on vertices and edges.

## [0.6.0] - 2026-10-31

Spatial filters, phase A: the three spatial classes in the types, `validate` and `text`, so a client can build,
check and send them to servers. The engines (`evaluate`, then the SQL dialects) follow in later versions.

### Added

- Basic Spatial Functions, Basic Spatial Functions with additional Spatial Literals and Spatial Functions:
  `s_intersects`, `s_equals`, `s_disjoint`, `s_touches`, `s_within`, `s_overlaps`, `s_crosses`, `s_contains`, a
  geometry property first and a geometry literal (GeoJSON) or `{ "bbox": … }` second. `CONFORMANCE.basicSpatial`,
  `basicSpatialPlus`, `spatial`; `requiredConformance` names the class each filter needs.
- `validate`: `invalid-geometry` for coordinates outside CRS84 (longitude −180…180, latitude −90…90), positions of
  other than 2 or 3 numbers, rings not closed or too short, LineStrings of one position, collections of one member or
  nested, a box of the wrong size or with its south above its north; a box across the antimeridian (west > east) and
  heights are accepted. With queryables, a spatial predicate needs a geometry queryable.
- `toText`: geometries as WKT per the grammar (`POINT Z(…)`, `MULTIPOINT((…), (…))`, `BBOX(…)` with 4 or 6 numbers);
  `textProblem` reports `mixed-dimensions`.
- `Cql2Error` code `unsupported`: `evaluate` and `toSql` refuse a spatial filter, naming the class.
- Types for geometries, `BboxLiteral`, `SpatialLiteral`, `SpatialOperator`, `SpatialPredicate`.

### Changed

- The three spatial URIs moved from `OTHER_CONFORMANCE` to `CONFORMANCE`.
- A geometry literal in a comparison is now `wrong-arguments` (CQL2 comparisons don't take geometries).
- A geometry's own GeoJSON `bbox` member is refused: CQL2's JSON Schema refuses it.

## [0.5.0] - 2026-10-31

Accent-insensitive Comparison: `ACCENTI`, so `São Paulo` matches `Sao Paulo`, in every engine.

### Added

- The class Accent-insensitive Comparison, `CONFORMANCE.accentInsensitive`: `ACCENTI` in comparisons, LIKE and IN,
  combined with `CASEI` either way (`CASEI(ACCENTI(x))`, `ACCENTI(CASEI(x))`), as the standard's grammar allows.
  Exactly the standard's rule: canonical decomposition, the nonspacing marks (Unicode 15.0.0, category Mn) removed,
  the Japanese voicing marks kept.
- Types `AccentiProperty`, `AccentiString`, `CaseiOf`, `AccentiOf`, `StringSubject`, `FoldedString`.
- `sqliteFunctions.cql2_accenti`; `postgresFunctions` also creates `cql2_accent_marks` and `cql2_accenti` (run it
  again on an existing database); `duckdbFunctions.cql2_fold_cmp` and `cql2_fold_like`.

### Changed

- `OTHER_CONFORMANCE.accentInsensitive` is now `CONFORMANCE.accentInsensitive`.
- `CaseiProperty` and `CaseiString` may wrap `ACCENTI`.
- A page importing only `ogc-cql2/evaluate` also carries the table of marks (about 1.5 kB gzipped).

## [0.4.0] - 2026-10-31

Correctness checked against more sources: CQL2-text against the standard's own text examples, and the right
conformance class for spatial literals.

### Added

- `OTHER_CONFORMANCE.basicSpatialPlus`, the class Basic Spatial Functions with additional Spatial Literals.

### Fixed

- `validate` named Basic Spatial Functions for `s_intersects` with a polygon, a line or another geometry that isn't a
  point or a box; such a literal needs `basic-spatial-functions-plus`. Three of the standard's examples are affected.

### Tests

- `toText` against the standard's text examples: for all 47 in the profile, our text and the standard's are read back
  with cql2-rs (`cql2-wasm`, a development dependency) and must give the standard's JSON.
- NaN and ±Infinity in the SQLite and DuckDB differential tables: the engines agree (NaN above every number), so
  nothing changed; recorded in `docs/architecture.md` with PostgreSQL's check.

## [0.3.0] - 2026-10-31

Type checks against a collection's queryables: a filter comparing a property with a literal of another type is
refused with an error, instead of silently matching nothing, as CQL2 permits (`/per/basic-cql2/type-casts`).

### Added

- `validate(filter, { queryables })`: the `properties` of an OGC API Features Part 3 queryables response, as it
  comes. A property that isn't one of them is `unknown-property` (a new `ProblemCode`); a literal that can't be of the
  property's type is `type-mismatch`, with a message saying what to write instead (`"5"` for a number, a string for a
  date, LIKE or CASEI on a non-string, BETWEEN on a non-number). A JSON Schema list of types (`["integer", "null"]`)
  is understood. Without `queryables`, `validate` is unchanged.
- Type `Queryable` (`type`, `format`); `SqlColumn` extends it.

### Unchanged

- `evaluate` and `toSql` still give NULL for a type mismatch: the check is at the boundary, where the queryables are
  known.

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

[0.7.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.1.0
[0.0.1]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.0.1
