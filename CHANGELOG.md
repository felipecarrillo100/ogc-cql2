# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Since 1.0.0, a minor version adds and never breaks (README,
"Versioning and stability"); before it, a minor version could change the API.

## [1.0.0] - 2026-11-01

The API freeze: 0.12.0's API, now kept stable under the policy in the README's "Versioning and stability". From here
on, a breaking change needs a major version; minor versions add (filter shapes, codes, classes, dialects). No change to
any function, option or type since 0.12.0, and none to what any filter selects.

### Documented

- SpatiaLite needs GEOS 3.13 or later for a GeometryCollection literal (README, `SqlOptions.spatialite`): with GEOS
  3.12 (Ubuntu 24.04's build), S_TOUCHES and S_OVERLAPS against a collection of a point and a line select other rows
  than `evaluate`. Found while setting up CI on Linux; GEOS 3.14 (Ubuntu 26.04) and 3.15 agree.

### Tested

- Continuous integration on GitHub Actions (checks only: nothing is published from it): the typecheck, the tests, the
  build and its checks on Node 22 and 24, Linux amd64 and arm64, and demo-server's tests against PostgreSQL + PostGIS,
  on every push; the newest DuckDB engines weekly.

## [0.12.0] - 2026-11-01

The last breaking changes before 1.0.0, and what 1.0.0 will keep stable.

### Changed (breaking)

- **Node 22 or later** (`engines`). Node 20 reached its end of life on 2026-04-30; stay on 0.11.x for it.
- **`OTHER_CONFORMANCE` is removed,** for `CQL2_CONFORMANCE`, under the same keys:
  `OTHER_CONFORMANCE.temporal` → `CQL2_CONFORMANCE.temporal`. It listed the classes not implemented yet, so it would
  have lost a key with each class implemented. The classes not implemented are those of `CQL2_CONFORMANCE` that
  `CONFORMANCE` doesn't hold.

### Added

- `CQL2_CONFORMANCE`: CQL2 1.0's twelve filter classes, fixed as the standard is (not the two encoding classes).
  `CONFORMANCE`, the implemented ones, takes its values from it.
- **The stability policy** (README, "Versioning and stability"): what 1.0.0 keeps stable, and what minor versions add
  as the package grows (filter shapes, codes, classes, dialects), so code keeps a default case. The README's Validate
  section tells a server to pass the classes it declares.

### Changed

- `SqlColumn.covering` on a DuckDB table with an R-tree index: the documented failure is DuckDB 2.0's alone. DuckDB
  1.4 and 1.5 (DuckDB-WASM's engines) answer such a query exactly, still through the index; leaving the covering out
  stays the advice, as the index is faster on its own. The canary expects the failure on DuckDB 2.0 and later only.
  Reported upstream: [duckdb-spatial #906](https://github.com/duckdb/duckdb-spatial/issues/906).

## [0.11.0] - 2026-11-01

Reading CQL2-text: `ogc-cql2/parse`, for servers that receive the `filter` parameter of OGC API Features Part 3 as
text (`filter-lang=cql2-text`, its default).

### Added

- `ogc-cql2/parse`, a new entry point: `fromText(text, options?)` reads CQL2-text into CQL2-JSON, then checks it
  against the profile with `validate`'s options (queryables, conformance classes). It reads the standard's whole
  grammar (`cql2.bnf`, tag `cql2-1.0.0`), every class, so valid CQL2 outside the profile is refused as
  `invalid-filter`, naming the class, as it is in CQL2-JSON. It reads as the grammar says:
  - keywords in any case, and property names in double quotes;
  - Requirement 21's escapes (`''`, `\'`, `\a \b \t \n \v \f \r`), with `\%` and `\_` kept in LIKE patterns;
  - the NOT forms as the standard's JSON writes them;
  - geometries with `Z` optional;
  - the standard's JSON names.

  What the grammar doesn't define is refused, never guessed: `EMPTY`, `!=`, an undefined escape, a keyword as a bare
  property name, and anything left over after the filter.
- `Cql2ErrorCode` `invalid-text`: text that isn't CQL2-text, with `details.position` (a UTF-16 index) and
  `details.expected`.

### Fixed

- `toText`:
  - It refuses a string holding a character CQL2-text strings can't hold (U+0000–U+0006, U+000E–U+001F, U+FFFE,
    U+FFFF, a lone surrogate) as `not-expressible`, with the new `textProblem` code `"character"`. Before, it wrote
    them as they are, which isn't valid CQL2-text. BEL, BS, tab, LF, VT, FF and CR are still written as they are: the
    grammar allows them.
  - It writes a property name holding U+1680 (Ogham space mark) in double quotes. The grammar has U+1680 both as
    whitespace and as an identifier character, so a reader could take it for a space and read another property.
  - A geometry mixing 2D and 3D positions is refused with its own message, not the backslash one.

### Tests

- The standard's 120 text examples (109, and 11 other texts of them) read exactly as their JSON examples, in Node and
  in Chrome 156.
- Every reading rule, with each refusal's position.
- Round trips: `fromText(toText(f))` gives `f` exactly, on over 10,000 generated filters and on the spatial tests'
  filters.
- The same texts read alike by cql2-rs 0.5.6 (its known deviations listed), and once by pycql2 0.2.0 (every
  disagreement its own).
- Each new rule broken once on purpose, to show the tests catch it.

### Demo server

- `POST /collections/{id}/query` accepts `"filter-lang": "cql2-text"` with the filter as a CQL2-text string, read
  with `fromText` and the collection's queryables. Text that isn't CQL2-text is refused as `invalid-text`, with its
  position. CQL2-JSON stays the default.

## [0.10.0] - 2026-10-31

The Spatial Functions class: S_EQUALS, S_DISJOINT, S_TOUCHES, S_WITHIN, S_OVERLAPS, S_CROSSES, S_CONTAINS, in every
engine, exactly as GEOS's DE-9IM decides them.

### Added

- `evaluate`: `EvaluateOptions.spatialEngine`, an optional planar geometry engine (`SpatialEngine`: `prepare(literal)`
  returning `relate(geometry)`, the DE-9IM matrix). With one, `evaluate` accepts the Spatial Functions class; the
  package decides each relation from the matrix (Simple Features' patterns, the dimension rules), keeps NULLs and empty
  geometries from the engine, and gives NULL when the engine throws. GEOS through geos.js is recommended (README).
- `toSql` with `dialect: "postgres"`: the other relations, exact and indexed: `ST_Equals`; `ST_Touches`,
  `ST_Overlaps`, `ST_Crosses` behind `&&`; S_WITHIN and S_CONTAINS as `ST_Relate` with their patterns behind `@` and `~`
  (`ST_Within` / `ST_Contains` take PostGIS's point-in-polygon shortcut).
- `toSql` with `dialect: "duckdb"`: the other relations through the spatial extension, with the GeoParquet covering's
  comparisons first outside a NOT.
- `toSql` with `dialect: "sqlite"` and `SqlOptions.spatialite: true` (SpatiaLite loaded on the connection): the other
  relations; `sqliteFunctions.cql2_wkt` reads what SpatiaLite can't (WKB, extended WKB, empty geometries).
- S_DISJOINT everywhere, as NOT S_INTERSECTS.
- package.json `funding`; the README's "Tested versions" and "Donations & sponsoring".

### Changed

- The SQL dialects and `evaluate` no longer refuse the Spatial Functions class where they have an engine for it:
  `evaluate` with `spatialEngine`, `postgres`, `duckdb`, `sqlite` with `spatialite`.

### Tests

- The standard's Table 14 (all 26 predicates) on Natural Earth, now converted at full precision from the shapefiles
  (Table 12 unchanged).
- Every relation against GEOS: GEOS's own predicates on tricky pairs; PostGIS on the US states (demo-server); the SQL
  of each dialect against `evaluate` with GEOS on every storage form; the PostGIS version matrix (3.1–3.7, amd64 and
  arm64); DuckDB 2.0, 1.4.3 and 1.5.4; DuckDB-WASM 1.32.0 and 1.33.1 in Chrome; the suite on Node 20, 22 and 24.
- geos.js 0.1.5 as a devDependency (tests only), and in demo-server, whose GeoJSON, PostgreSQL and (with SpatiaLite)
  GeoPackage stores answer the class.

## [0.9.1] - 2026-10-31

The `postgres` dialect's S_INTERSECTS made exact on every platform and PostGIS version.

### Fixed

- `postgres`: `s_intersects` is `geom && literal AND NOT ST_Relate(geom, literal, 'FF*FF****')`, decided by GEOS's
  DE-9IM matrix. The former `NOT ST_Disjoint`, like `ST_Intersects`, goes through PostGIS's own point-in-polygon test
  from PostGIS 3.7, which on arm64 (Apple Silicon, AWS Graviton) misses points lying exactly on an edge: 109
  point-and-state pairs of the tests' literals on the US states.

### Changed

- `postgres`: a GeometryCollection literal in `s_intersects` is tested member by member (the same answer), as GEOS
  3.11's `ST_Relate` refuses collections.

### Documentation

- PostGIS: the expression indexes that make a column in another SRID (`ST_Transform(geom, 4326)`) or a geography
  column (`(geog::geometry)`) fast; GEOS 3.13 or later for columns holding GeometryCollections.

### Tests

- `npm run check:duckdb`: the DuckDB spatial suite on the newest engines (the newest `@duckdb/node-api`, and the
  engine inside the newest DuckDB-WASM), installed in a temporary folder, with what to update for each failing test.
  Not part of `npm test`, nor of publishing.

## [0.9.0] - 2026-10-31

Spatial filters, phase D: `s_intersects` in the `sqlite` (GeoPackage) and `duckdb` dialects, exact in both.

### Added

- `toSql` with `dialect: "sqlite"`: `s_intersects` (Basic Spatial Functions and Basic plus) on a geometry column
  (`format: "geometry-…"`) holding GeoPackage blobs or WKB, through `sqliteFunctions.cql2_intersects`, which runs
  `evaluate`'s own engine; the blob's header envelope rejects most rows before decoding.
- `SqlColumn.rtree`: GeoPackage's R-tree table for the column, used to find the candidates first, for a filter that
  isn't negated (negate the filter, not the SQL).
- `toSql` with `dialect: "duckdb"`: `s_intersects` with the spatial extension, as `ST_Intersects(geom, literal)`, the
  form DuckDB documents, on a `GEOMETRY` column or a `BLOB` of WKB (`TRY(ST_GeomFromWKB(…))`); exact, measured against
  `evaluate`; it uses an R-tree index on DuckDB 1.4 (DuckDB-WASM) and 2.0, also across the antimeridian.
- `SqlColumn.covering`: GeoParquet's bbox covering, as the file's `geo` metadata gives it. The `duckdb` dialect then
  compares its four fields first, which skips Parquet row groups and most rows (DuckDB doesn't use a covering by
  itself), for a filter that isn't negated. Not for a table with an R-tree index: DuckDB 2.0 fails on that query.

### Changed

- The `sqlite` and `duckdb` dialects no longer refuse the two basic spatial classes; Spatial Functions stay
  `unsupported` in every dialect.
- `duckdb`: number parameters are now text (`"0.5"`, cast to DOUBLE in the SQL); the SQL text is unchanged.

### Fixed

- `duckdb` in DuckDB-WASM (since 0.2.0): about one number in ten that needs 17 significant digits was bound one unit
  off (`0.9653517007827759` as `0.965351700782776`), so a comparison with it could select the wrong rows. Numbers are
  now bound as text, which DuckDB reads exactly.
- `evaluate`: an empty Point written as `{"type": "Point", "coordinates": []}` is empty (S_INTERSECTS false), not NULL.

### Tests

- `test/sql-spatial.test.ts`: 132 spatial filters in SQLite (GeoPackage blobs with and without the envelope, WKB,
  extended WKB, GeoPackage's R-tree) against `evaluate`; 17-digit numbers in the DuckDB differential table; the 5,705
  literals through demo-server's GeoPackage store; the browser check re-run, with and without a covering.
- `test/duckdb-spatial.ts`, run on DuckDB 2.0 and on DuckDB 1.4.3, the engine DuckDB-WASM 1.32.0 ships (a new
  devDependency, `@duckdb/node-api-1.4`): the same filters on `GEOMETRY` and `BLOB` columns, without and with a
  covering; the R-tree index's use; and canaries that fail when a DuckDB release changes what the dialect relies on.
  The timing canary only reports its ratio, and fails only with `CQL2_CANARY_TIMING=1`, so the machine's load can't
  fail a test run.

## [0.8.0] - 2026-10-31

Spatial filters, phase C: `s_intersects` in the `postgres` dialect (PostGIS), exact and using the spatial index.

### Added

- `toSql` with `dialect: "postgres"`: `s_intersects` (Basic Spatial Functions and Basic plus) as
  `geom && literal AND NOT ST_Disjoint(geom, literal)`: the box test uses the GiST index, GEOS decides exactly. Chosen
  by measurement: as fast as `ST_Intersects`, which isn't exact for a point lying exactly on an edge.
- `SqlColumn.srid`, and geometry columns by `sqlType` (`geometry`, `geometry(Point, 3857)`, `geography`) or by a
  geometry `format`; a column in another SRID is transformed to 4326.

### Changed

- The `postgres` dialect no longer refuses the two basic spatial classes; SQLite and DuckDB still do, and Spatial
  Functions stay `unsupported` in every dialect.
- README: the classes table has separate `evaluate` and `sql` columns.

### Tests

- 5,705 literals through the `postgres` dialect against `evaluate` on the US states; spatial filters in demo-server's
  four-store comparison (PostgreSQL in 4326 and in 3857).

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

[1.0.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.12.0...v1.0.0
[0.12.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/felipecarrillo100/ogc-cql2/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.1.0
[0.0.1]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.0.1
