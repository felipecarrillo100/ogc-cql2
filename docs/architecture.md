# Architecture

The design as of 0.1.0. For the reasons behind it, see [vision.md](vision.md).

## One format inside: CQL2-JSON

A filter is a plain CQL2-JSON object, as the standard's JSON encoding defines it. The package has no format of its own
to convert from or to. That means:
- a filter can be stored or sent as it is (`JSON.stringify`);
- the same object can go to a server that accepts `filter-lang=cql2-json`;
- CQL2-text is produced from it when a server needs text.

```json
{
  "op": "and",
  "args": [
    { "op": ">=", "args": [{ "property": "population" }, 100000] },
    { "op": "like", "args": [{ "op": "casei", "args": [{ "property": "name" }] }, { "op": "casei", "args": ["san%"] }] },
    { "op": "<", "args": [{ "property": "updated" }, { "timestamp": "2026-01-01T00:00:00Z" }] }
  ]
}
```

## The profile

Four conformance classes, implemented completely: Basic CQL2, Advanced Comparison Operators, Case-insensitive
Comparison and (since 0.5.0) Accent-insensitive Comparison. Since 0.6.0 the three spatial classes too (Basic Spatial
Functions, Basic plus, Spatial Functions) in `validate` and `text`; `evaluate` and `sql` refuse them (`unsupported`)
until their engines arrive, see [spatial-research.md](spatial-research.md). `CASEI` and `ACCENTI` may each wrap the other once, as the
grammar allows (`CASEI(ACCENTI(name))`). Within them, the profile accepts the form every server must support: the standard lets a server accept
only a property on the left and a literal on the right (`/per/basic-cql2/cql2filter`,
`/per/advanced-comparison-operators/*`). So:

- `property op literal`, with `casei` around the property, the literal, or both;
- `like(property, pattern)`, `between(property, number, number)`, `in(property, [literals of one type])`;
- `isNull(property)`;
- `and` / `or` of two or more filters, `not` of one; `true`, `false`.

## Entry points

Each part is its own entry point, with its own folder under `src/`. A part imports only what it needs, so a bundler
drops the rest.

| Import | Folder | Gives | Status |
|---|---|---|---|
| `ogc-cql2` | `src/` + `src/core/` | The profile's types (`Cql2Filter` …); `Cql2Error`; `CONFORMANCE` (the profile's classes) and `OTHER_CONFORMANCE` (the ones named in refusals); `CQL2_VERSION` | 0.1.0 |
| `ogc-cql2/validate` | `src/validate/` | `validate`, `assertValid`, `requiredConformance`, `filterProperties` | 0.1.0 |
| `ogc-cql2/text` | `src/text/` | `toText`, `textProblem`, `isIdentifier`, `quoteString` | 0.1.0 |
| `ogc-cql2/evaluate` | `src/evaluate/` | `toPredicate`, `toEvaluator`, `evaluate` | 0.1.0 |
| `ogc-cql2/sql` | `src/sql/` | `toSql` (CQL2-JSON → a parameterized `WHERE` clause), `sqliteFunctions`, `postgresFunctions`, `postgresValue`, `duckdbFunctions`, `duckdbValue` | 0.1.0: dialects `sqlite` and `postgres`; 0.2.0: `duckdb` |
| `ogc-cql2/parse` | `src/parse/` | CQL2-text → CQL2-JSON, for a Node server that receives text | 1.x.x |

`text`, `evaluate` and `sql` validate their input first, so they load `validate` too.

## The parts

### Validation (`ogc-cql2/validate`)

- **Hand-written for the profile,** with no JSON Schema library at run time.
- **It checks more than the official JSON Schema can:**
  - the schema accepts any unknown operator as a custom function call, so it can't tell a typo from a function.
    `validate` reports it as `unknown-operator`;
  - it checks that a date or timestamp exists (no 30 February), that an `IN` list holds one type and isn't empty, and
    that `casei`, `like` and `between` get the types they need.
- **Valid CQL2 outside the profile** is `outside-profile`, never "invalid", and names the class it needs.
- **`options.conformance`:** the classes a server declares. A profile class the filter uses but the list lacks is
  `needs-conformance`.
- **`options.queryables`:** a collection's queryables (OGC API Features Part 3), as the response gives them. A property
  not among them is `unknown-property`; a literal that can't be of the property's type (`"5"` for a number, a string
  for a date) is `type-mismatch`, with a message saying what to write. CQL2 requires both sides of a comparison to be
  of one type (`/req/basic-cql2/binary-comparison-predicate` D) and lets a server answer a mismatch with an error or a
  cast (`/per/basic-cql2/type-casts`). Without queryables the package can't know a property's type, and the
  engines give NULL, which is neither: the queryables are what lets a server give the error. Measured on the DuckDB
  test's typed table: 2,950 of 4,548 generated single comparisons are refused; 2,343 of them could never select a row
  (an empty answer without a word, before), and the other 607 matched only through a cast between strings and dates
  (GeoJSON has no date type, so a date is served as text). A test checks that nothing else is ever refused.
- **Spatial literals** (GeoJSON geometries, `{ "bbox": … }`) are checked beyond the schema: CRS84 ranges
  (the standard's conformance test requires `POINT(90 180)` to fail), closed rings, a box's south below its north
  (west greater than east is a box across the antimeridian), 2 or 3 numbers per position. A geometry's own GeoJSON
  `bbox` member is refused, as the schema refuses it (`oneOf` geometry or bbox literal). The class named follows the
  standard: S_INTERSECTS with a point or a box is Basic, with another geometry Basic plus, another relation Full.
- **Every problem** is reported, each with a code, a JSON Pointer and a message.
- **The official schema is used in the tests:** every filter the tests treat as valid must pass it, and every
  structurally broken one must fail it.

### CQL2-text (`ogc-cql2/text`)

It follows the text encoding's released grammar (`cql2.bnf`, tag `cql2-1.0.0`) exactly:
- **identifiers:** a property name equal to one of the standard's 51 keywords, in any case, is written in double
  quotes. A name that isn't an `identifier` can't be written at all;
- **character literals:** in single quotes, with each quote doubled;
- **`LIKE` patterns:** written as they are; `%`, `_` and their escapes `\%`, `\_` are the standard's own;
- **backslashes:** Requirement 21 makes `\` the escape character in every literal and defines no escape for itself,
  so any other backslash in a string can't be written;
- **numbers:** with the grammar's exponent `E` (`1E+21`);
- **dates and timestamps:** `DATE('…')` and `TIMESTAMP('…')`;
- **AND / OR:** each operand in parentheses, so precedence never depends on the reader.

What the text can't express is refused as `not-expressible`, with the reason and the path. Nothing is approximated.

### Evaluation (`ogc-cql2/evaluate`)

- **Three-valued logic,** following the standard:
  - a comparison, `LIKE`, `BETWEEN` or `IN` on a missing or null value is *unknown*;
  - `IS NULL` is never unknown;
  - `AND` / `OR` follow the standard's Table 2, and `NOT` its Table 3;
  - a feature is selected only when the result is *true*.
- **What the standard leaves to the implementation** is decided as follows, and documented in the code:
  - a value of another type than the literal is *unknown*: values are never converted;
  - `{date}` matches a `"YYYY-MM-DD"` string or a `Date` (its UTC day); `{timestamp}` an ISO 8601 string with `Z` or
    an offset, or a `Date`, to the millisecond. A time without an offset is ambiguous, so *unknown*. Both are read
    strictly (see the end of the SQL section), not with JavaScript's lenient `Date.parse`;
  - strings are compared after NFC normalization (the standard's Recommendation 1), in code point order;
  - a `LIKE` `_` matches one code point.
- **`CASEI`** applies Unicode's full case folding (CaseFolding 15.0.0, statuses C and F), as the standard requires.
  JavaScript has none built in, so `scripts/gen-case-folding.mjs` generates a compact table
  (`src/evaluate/caseFolding.ts`, about 1.5 kB gzipped). It folds exactly what it wraps.
- **`ACCENTI`** removes the nonspacing marks after canonical decomposition (Unicode 15.0.0, category Mn), keeping the
  Japanese voicing marks (the standard's Recommendation 2), then recomposes to NFC. `scripts/gen-accent-marks.mjs`
  generates the table of marks from `UnicodeData.txt` (`src/evaluate/accentMarks.ts`, 1,983 code points in 345
  ranges, about 1.5 kB gzipped). Nested with `CASEI`, each applies in the order written, innermost first. See
  [accent-research.md](accent-research.md).
- **Features** are read as GeoJSON, `feature.properties[name]`; `getProperty` replaces that for other shapes.
- **`S_INTERSECTS`** (`src/evaluate/spatial.ts`, no dependency): planar, boundaries included, heights ignored, as
  Simple Features and GEOS define it. Each geometry is taken apart into points, segments and polygons; two
  geometries intersect when a point lies on or in the other, two segments meet, or a part of one lies inside a
  polygon of the other (one vertex per component tells, once no boundaries meet). Orientation is exact: Shewchuk's
  `orient2d`, as ported in robust-predicates (public domain), copied with types into `src/evaluate/orient2d.ts` and
  checked identical to the original on 1,000,000 inputs. A box across the antimeridian is two boxes. Each feature
  geometry's bounding box is computed once (cached per object) and tested first. The other relations (Spatial
  Functions) are `unsupported` in `evaluate`.
- **Compiled once:** `toPredicate` and `toEvaluator` validate the filter and prepare its patterns and literals, so
  each feature costs only the comparisons.

### SQL (`ogc-cql2/sql`)

`toSql(filter, { dialect, columns })` returns `{ where, params }`: text and values only, no driver. The rule: the SQL
selects exactly the rows `evaluate` selects from the same values.

- **Always parameterized:** values are placeholders (`?` for `sqlite`, `$1`, `$2` … for `postgres` and `duckdb`), never
  text inside the query.
- **Property names are checked** against `columns` (the table's queryables), then quoted; anything else is
  `unknown-property`. A property can map to a column of another name.
- **CQL2's three-valued logic maps directly** onto SQL's NULL (`AND`, `OR`, `NOT`).
- **The pattern others use:** a field mapping and a function map, as pygeofilter's SQL backend does; unlike it, values
  are never put into the SQL text.
- **One walker, one file per dialect:** `toSql` (`src/sql/index.ts`) walks the filter; what differs per database is
  a `Dialect` (`src/sql/types.ts`), one file each in `src/sql/dialects/`: the placeholders, the boolean constants and
  the "no value can match" constant, the column's **view** for each kind of value (text, CASEI, number, boolean,
  day, instant), LIKE, and how boolean and instant literals are passed. A view can also convert the literal's value
  and replace `view op param` with its own condition, which DuckDB's CASEI needs.

The `sqlite` dialect follows **GeoPackage** (OGC 12-128r19, version 1.4): its declared types (Table 1, Req 5), its
BOOLEAN as INTEGER 0 / 1, DATE as `YYYY-MM-DD`, DATETIME as `YYYY-MM-DDTHH:MM[:SS.SSS]Z`, and its note that readers
SHOULD allow for values of an unexpected type, which SQLite permits in any column.

| CQL2 | SQLite |
|---|---|
| `and`, `or`, `not`, `isNull`, `true` / `false` | `AND`, `OR`, `NOT`, `IS NULL`, `1` / `0` |
| a comparison, `between`, `in` | on a **typed view** of the column: each value of another type is NULL there, as `evaluate` gives NULL for a type mismatch |
| numbers | `CASE WHEN typeof(c) IN ('integer', 'real') THEN c END`; on a BOOLEAN column, 0 and 1 are booleans, not numbers |
| booleans | only in a BOOLEAN column, as 0 / 1; elsewhere the comparison is `NULL` (SQLite stores no booleans) |
| text | `cql2_text(c)`: NFC; binary order, which is code point order |
| `casei(…)` | `cql2_casei(…)`: Unicode full case folding |
| `accenti(…)` | `cql2_accenti(…)`: the accents removed; nested, the calls compose (`cql2_casei(cql2_accenti(c))`) |
| `{date}` | `cql2_day(c)`: a `YYYY-MM-DD` value |
| `{timestamp}` | `cql2_instant(c)`: an ISO 8601 date-time with `Z` or an offset, in milliseconds |
| `like` | `cql2_like(view, pattern)`: case-sensitive, `%` `_` `\` |

The `cql2_*` functions are `sqliteFunctions`, which the application registers on its connection. They run the same
code as `evaluate` (`src/evaluate/strings.ts`). SQLite's own LIKE ignores ASCII case (its `case_sensitive_like`
pragma is deprecated) and its `lower()` folds ASCII only, so neither can be used.

**The cost of exactness:** the typed views and functions stop SQLite from using an index for those predicates. An
index-friendly mode, for tables whose values are known to match their declared types, can come later, measured
against the same tests.

The `postgres` dialect, for PostgreSQL: columns are statically typed, so a literal that can't match a column's type
is `NULL::boolean` when the SQL is built, and `SqlColumn.sqlType` (the declared type) picks each column's view.

| CQL2 | PostgreSQL |
|---|---|
| `and`, `or`, `not`, `isNull`, `true` / `false` | `AND`, `OR`, `NOT`, `IS NULL`, `TRUE` / `FALSE`; placeholders `$1`, `$2` … |
| numbers | `c::double precision` against `$n::double precision`: compared as the numbers the application serves |
| booleans | `c` against `$n::boolean` |
| text | `normalize(c::text, NFC) COLLATE "C"`: code point order; the database's collation sorts by language rules |
| text against a `date` / `timestamptz` / `timestamp` column | the served text: `to_char(…)` as `YYYY-MM-DD`, UTC `…Z` with milliseconds, or without `Z` |
| `casei(…)` | `cql2_casei(…)` |
| `accenti(…)` | `cql2_accenti(…)`, from the table `cql2_accent_marks` (`unaccent` follows a dictionary, not the standard's rule); nested, the calls compose |
| `{date}` | `c` against `$n::date` on a `date` column; `cql2_day(c)` on text |
| `{timestamp}` | `date_trunc('milliseconds', c)` against `$n::timestamptz` on `timestamptz`; `cql2_instant(c)` on text; NULL on `timestamp` (no offset) |
| `like` | native `LIKE` (case-sensitive, `\` escape) on the NFC text; a lone trailing `\` becomes a literal one |

`postgresFunctions(schema)` is the SQL creating `cql2_casefold` (the package's case-folding table), `cql2_casei`,
`cql2_day` and `cql2_instant`. PostgreSQL's `lower()` isn't Unicode case folding, and `casefold()` only came with
PostgreSQL 18 and is exact only with the `PG_UNICODE_FAST` provider. `postgresValue(column)` is the SELECT expression
that serves each column as the dialect compares it.

**Dates and instants are read strictly, the same in every engine:** a day must exist, hours are 00–23, minutes and
seconds 00–59, a fraction is truncated to milliseconds. JavaScript's `Date.parse` is lenient (it reads 2023-02-30 as
2 March); PostgreSQL rolls a leap second into the next minute. A leap second in a filter is refused
(`invalid-timestamp`).

The `duckdb` dialect, for DuckDB: **the same SQL in Node (`@duckdb/node-api`) and in the browser
(`@duckdb/duckdb-wasm`)**, on tables or straight on files (GeoParquet, Parquet, CSV). Statically typed like
PostgreSQL: `SqlColumn.sqlType` is the type `DESCRIBE` gives.

| CQL2 | DuckDB |
|---|---|
| `and`, `or`, `not`, `isNull`, `true` / `false` | `AND`, `OR`, `NOT`, `IS NULL`, `TRUE` / `FALSE`; placeholders `$1`, `$2` … |
| numbers | `CAST(c AS DOUBLE)` against `$n::DOUBLE` |
| booleans | `c` against `$n::BOOLEAN` |
| text | `nfc_normalize(c) COLLATE "binary"`: code point order, whatever the database's `default_collation` (`nocase` would make `'a' = 'A'` true) |
| text against a `DATE` / `TIMESTAMP WITH TIME ZONE` / `TIMESTAMP` column | the served text, through `strftime` |
| `casei(…)` | `cql2_casei_cmp(c, $n) op 0`; `IN` as `= 0` conditions joined with `OR`; LIKE as `cql2_casei_like(c, $n) = 1` |
| `accenti(…)`, and nested with `casei` | `cql2_fold_cmp(c, $n, 'accenti,casei') op 0` and `cql2_fold_like(…) = 1`, the folds named innermost first. DuckDB's `strip_accents` differs from the standard's rule on 548 code points (Indic spacing vowel signs, enclosing marks, the Japanese voicing marks: measured over every code point), so it isn't used |
| `{date}` | `c` against `$n::DATE` on a `DATE` column; `cql2_day(c)` (days since 1970) on text |
| `{timestamp}` | `floor(epoch_us(c) / 1000)` (epoch milliseconds, truncated: `epoch_ms` rounds) on `TIMESTAMP WITH TIME ZONE`; from `cql2_instant_day` and `cql2_instant_ms` on text; NULL on `TIMESTAMP` |
| `like` | native `LIKE … ESCAPE '\'` (case-sensitive, `_` one code point) on the NFC text; a lone trailing `\` becomes a literal one |

`duckdbFunctions` are plain JavaScript functions with their DuckDB types, registered on the connection by the
application (`registerScalarFunction` in Node, `createScalarFunction` in DuckDB-WASM's blocking build, run in a Web
Worker). **They all return 32-bit integers**, the one result type DuckDB-WASM (1.32.0, and 1.33.1-dev110) passes back
exactly from JavaScript: text comes back as zero bytes, DOUBLE as a 32-bit float, BIGINT cut to 32 bits, and BOOLEAN
is refused. So CASEI compares inside the function, and an instant read from text is its UTC day plus the
milliseconds into that day. Nothing depends on the time-zone setting: instants are compared as numbers.

### Errors

- **Every refusal throws a `Cql2Error`:** `invalid-filter` (from `assertValid`, and from `text` and `evaluate` for an
  invalid input), `not-expressible` (from `toText`) or `unknown-property` (from `toSql`, for a property not in
  `columns`), with a message, the path inside the filter and `details`.
- **Callers test the `code`, not `instanceof`.** That keeps working even when two copies of the package end up in one
  application.

## Deviations, deliberate

Where the standard leaves a choice, or recommends without requiring, the package's choice and why.

| Point | The standard | The package | Why |
|---|---|---|---|
| Unicode normalization form | strings SHOULD be normalized before comparing, and NFD is the recommended form (Recommendation 1, `/rec/core/string-normalization` B) | normalizes, to **NFC** | the same answers for `=`, `<>`, `IN` and CASEI (canonically equivalent forms); NFD would reorder 0.8% of string pairs in the tests' data (`<`, `>`…) and break LIKE's `_` on accented letters (`'caf_'` would no longer match `café`, as `é` is two code points in NFD); NFC is the W3C's form for string matching on the web and how data is stored; DuckDB has no NFD |
| Instants' precision | left to the server ("how this is implemented is a decision of the server") | milliseconds, a finer fraction truncated | JavaScript's precision; every engine (SQLite, PostgreSQL, DuckDB) is made to truncate the same way, so the results agree |
| Numbers that aren't finite (NaN, ±Infinity) in the data | no literal for them (`validate` refuses one as `invalid-number`); nothing about values | ordered as SQL orders them, the same in every engine: NaN above every number, ±Infinity at the ends | measured 2026-10-31 with NaN and ±Infinity rows in the SQLite and DuckDB tests and a check in PostgreSQL: 0 of 27,487 filters differ, so nothing is converted. A server that sends them as JSON sends `null` (JSON has no NaN), which a client re-filtering what it received reads as NULL |
| A type mismatch in the data | — | NULL | a value of an unexpected type in the data (which GeoPackage permits) is a problem of the data, not of the filter; a mismatch in the filter itself is refused by `validate` with the queryables |

## How it is used

- **A client application:**
  - keeps its filters as CQL2-JSON;
  - validates them, against what each server declares;
  - sends `ogc-cql2/text` output to OGC API Features servers;
  - and filters features it already holds with `ogc-cql2/evaluate`, for example as a map layer's filter function.
- **Other filter languages:** an application that also needs, for example, OGC Filter Encoding for WFS, translates
  from the same CQL2-JSON in its own code. Such translations are outside this package.
- **A Node server:**
  - accepts CQL2-JSON;
  - validates it;
  - evaluates it against stored features (`ogc-cql2/evaluate`), or builds SQL (`ogc-cql2/sql`);
  - and, if it must accept CQL2-text, parses it (`ogc-cql2/parse`, 1.x.x).

## The demo server (`demo-server/`, not published)

A Node backend (Express 5) that answers the playground's filters from data files, through a **store layer**: one
store per collection, each answering the same three questions (describe yourself, your queryables, the features a
filter selects). The server never knows which store it talks to.

| Store | Reads | Filters with | Status |
|---|---|---|---|
| GeoJSON | one FeatureCollection file, read once at startup | `ogc-cql2/evaluate` | 0.1.0 |
| GeoPackage (SQLite) | the `features` and `attributes` tables a GeoPackage lists in `gpkg_contents` (Node's built-in `node:sqlite`, read-only) | `ogc-cql2/sql` | 0.1.0 |
| PostgreSQL / PostGIS | the tables `collections.json` lists (never discovered); the connection in a git-ignored `.env` | `ogc-cql2/sql`, `postgres` dialect | 0.1.0 |
| GeoParquet (DuckDB) | the Parquet files `collections.json` lists, read in place with `@duckdb/node-api` | `ogc-cql2/sql`, `duckdb` dialect | planned, 0.2.0 |

- A GeoPackage table: the id is its INTEGER primary key (Req 29, 119), the queryables come from its declared types
  (Table 1), BOOLEAN 0 / 1 is served as `false` / `true`, and geometry is decoded from GeoPackageBinary (the `GP`
  header, then WKB) to GeoJSON. A table not in WGS 84 is served without geometry, and that's reported.
- A PostgreSQL table: the id is its primary key (or `id` in the config), the queryables come from the declared types,
  values are selected through `postgresValue`, and a PostGIS geometry is read as WKB, converted to WGS 84 with
  `ST_Transform` when needed.
- Every store answers GeoJSON features. A GeoJSON file's ids are kept when unique; missing ones are generated
  deterministically (the position in the file, or after the largest numeric id); a duplicate id drops the later
  feature, which is reported.
- The server validates each filter (`validate`), checks its properties against the collection's queryables
  (`filterProperties`), and refuses with HTTP 400 and `application/problem+json`.
- Only the server has dependencies (Express, and `pg` for PostgreSQL; SQLite is Node's built-in `node:sqlite`). The
  package stays free of them: `check:imports` and `check:bundle` (below) prove it on every publish.

## Testing

- **Unit tests** (Vitest) for every part.
- **The standard's own examples:** the 109 JSON examples of tag `cql2-1.0.0`, with the official JSON Schema, in
  `test/fixtures/ogc/` with OGC's licence notice (tests only, not published):
  - the schema accepts every example;
  - the ones in the profile validate and convert to CQL2-text, and **that text means what the standard's own text
    example means**: both are read back with cql2-rs (`cql2-wasm`, a development dependency) and must give the
    standard's JSON, for all 47. The texts differ only in presentation (spaces, keyword case, parentheses,
    `NOT (x IN …)` for `x NOT IN …`). cql2-rs 0.5.6 misreads one standard text (`example06a`: a BETWEEN followed by
    AND), so that one is checked through our text only;
  - every other one is refused only as `outside-profile` or `unknown-operator`, naming a conformance class.
- **The grammar:** identifier, keyword, escaping and number cases taken from the BNF.
- **Truth tables:** every operator against a matching value, a non-matching value, a null and a missing property;
  `AND` / `OR` / `NOT` as the standard's tables; case-folding cases; strict dates and instants.
- **SQL against real databases (differential tests):**
  - `test/sql.test.ts`: 12,984 generated filters on a SQLite table of awkward values (NULLs, values of an unexpected
    type, NFC and NFD, code points above U+FFFF, LIKE's special characters) select the same rows as `evaluate`;
  - `test/sql-duckdb.test.ts`: 24,136 generated filters on a DuckDB table (`@duckdb/node-api`, a dev dependency, in
    the test process) select the same rows as `evaluate` on the served values, also with `default_collation` set to
    `nocase` and a New York time zone;
  - the same filters in **DuckDB-WASM**, in Chrome: run for 0.2.0 and again for 0.5.0 (24,136 filters, 9,639 of them
    with ACCENTI) with a harness outside the repository (the same table and filters, the README's registration code,
    Vite's build), with the same result. The browser carries an
    older engine (DuckDB 1.4.3, against 2.0 in Node), so passing in Node doesn't prove the browser;
  - `demo-server/test/stores-agree.test.ts`: on the kitchen sink, 10,016 generated filters give the same features from
    the GeoJSON file, the GeoPackage and PostgreSQL (when the database is set up; skipped otherwise);
  - `test/naturalearth.test.ts`: the standard's own acceptance test for Basic Spatial Functions (Table 12, conformance
    test 26) on Natural Earth 1:110m (public domain, `test/fixtures/naturalearth/`): all eight counts;
  - `demo-server/test/spatial.test.ts`: S_INTERSECTS on the US states against GEOS (PostGIS's `NOT ST_Disjoint`), 5,705
    generated literals, many exactly on the states' vertices and edges: the same states. PostGIS's own
    `ST_Intersects` isn't the reference: its shortcut for a point in a polygon isn't exact for a point exactly on an
    edge (109 point-state pairs where it says false and GEOS's DE-9IM matrix puts the point on the boundary, measured
    on PostGIS 3.5.6); the test checks that every departure is such a point. This matters for the PostGIS dialect;
  - PostgreSQL's `cql2_accenti` against the JavaScript rule on every code point of the Basic Multilingual Plane
    (63,487) for 0.5.0: no difference;
  - each rule was broken once on purpose, to show the tests catch it.
- **Independent checks,** not part of the repository or of the package:
  - two other CQL2 parsers (cql2-rs, pycql2) read the text output back to the same CQL2-JSON;
  - **cql2-rs's evaluator** (Development Seed; `cql2` on PyPI, about 200,000 downloads a month, and `cql2-wasm` on
    npm, version 0.5.6), 2026-10-31: the DuckDB test's 11,050 filters on its 15 rows, 165,750 answers. 46% agree;
    52% are errors in cql2-rs (a type mismatch, which the standard lets it refuse; a missing property, where the
    standard requires NULL); 2% differ, all explained by the standard: dates and timestamps compared with each other
    (cql2-rs casts), CASEI (cql2-rs lowercases instead of the required full Unicode case folding: `Straße` vs
    `STRASSE`), `IN` with dates or timestamps (a bug in cql2-rs: its `=` agrees), normalization (cql2-rs has none),
    and precision below a millisecond. No bug of `ogc-cql2` was found. Both accept the same 47 of the standard's 109
    examples (those in the profile).

## Build and tooling

| Job | Tool |
|---|---|
| Build | tsdown: ESM, one output file per source module (`unbundle`), `.d.ts` files generated with `isolatedDeclarations` |
| Package checks | publint and arethetypeswrong, run with every build |
| Typecheck | TypeScript 7. `tsconfig.json` checks `src/` without DOM types, so the sources also run in Node; `tsconfig.dev.json` checks the tests, the demo and the config files |
| Tests | Vitest, with ajv and the official JSON Schema (development only) |
| Demo | Vite: the playground, importing the package by name, aliased to `src/` |
| Case folding | `node scripts/gen-case-folding.mjs <CaseFolding-15.0.0.txt>`, run when the Unicode version changes |
| `check:imports` | fails if `package.json` declares a runtime dependency, or a file in `dist/` imports anything but the package's own files |
| `check:bundle` | bundles a page that imports only `ogc-cql2/evaluate` and fails unless the bundle holds evaluate alone: no CQL2-text code, no SQL code, nothing Node-specific |
| `prepublishOnly` | typecheck, tests, build, `check:imports`, `check:bundle` |

Adding an entry point means adding it in two places: `tsdown.config.ts` and `exports` in `package.json`. publint
checks that they agree.

## Roadmap

| Version | What |
|---|---|
| 0.0.1 | The foundation: build, tests, demo, `CQL2_VERSION`, `quoteString` |
| 0.1.0 | The profile: types, `ogc-cql2/validate`, `ogc-cql2/text`, `ogc-cql2/evaluate`, `ogc-cql2/sql` (SQLite / GeoPackage, PostgreSQL / PostGIS); the playground and `demo-server` |
| 0.2.0 | The dialect interface in `src/sql` (SQLite and PostgreSQL moved onto it unchanged), and the **`duckdb`** dialect, the same SQL in Node and in the browser, tested in both; see [duckdb-case.md](duckdb-case.md) |
| 0.3.0 | `validate` with a collection's queryables: `unknown-property` and `type-mismatch` (`/per/basic-cql2/type-casts`); the deliberate deviations documented |
| 0.4.0 | `toText` checked against the standard's text examples (with cql2-rs); the right class for spatial literals |
| 0.5.0 | **Accent-insensitive Comparison** (`ACCENTI`), in every engine, combined with `CASEI`; see [accent-research.md](accent-research.md) |
| 0.6.0 | **Spatial, phase A:** the three spatial classes in the types, `validate` and `text` (WKT per the grammar), so spatial filters can be built, checked and sent; `evaluate` and `sql` refuse them (`unsupported`) |
| 0.7.0 | **Spatial, phase B:** `evaluate` tests `s_intersects` (Basic Spatial Functions and Basic plus) in memory, checked with the standard's Natural Earth test and against GEOS |
| next (demo only, not published) | GeoParquet files and a DuckDB store in `demo-server`, the kitchen sink then compared across four stores; DuckDB-WASM as a source in the playground, on desktop and on phones |
| next | **spatial engines**: Basic and Basic plus in the SQL dialects, Full in PostGIS, SpatiaLite, DuckDB and through an optional engine hook in `evaluate`, see [spatial-research.md](spatial-research.md) |
| 1.x.x | **More SQL databases, for enterprise GIS:** **Oracle** (Oracle Spatial), then **SQL Server** (spatial types), on the dialect interface. Details below. **`ogc-cql2/parse`:** CQL2-text → CQL2-JSON, for Node servers implementing OGC API Features Part 3, where `filter-lang=cql2-text` is the default for the `filter` parameter; its own entry point, so web apps don't load it; tested on the standard's text examples, on reading back `toText`'s output, and against cql2-rs and pycql2 |
| later | more conformance classes (temporal, arrays); JSON-FG: `place`, `coordRefSys`, `filter-crs` and 3D comparison; an index-friendly SQL mode |

### 1.x.x: Oracle and SQL Server

Chosen for geospatial users: both are common under enterprise GIS (national mapping agencies, utilities, defence;
Esri enterprise geodatabases; Luciad / Fusion; GeoServer and QGIS support both), and both have full DE-9IM spatial
relations for the spatial classes later. Each new dialect meets the same rule as the others: every generated filter
selects exactly what `evaluate` selects, checked on the kitchen sink loaded into that database.

| Step | What | Known questions |
|---|---|---|
| 1 | The dialect interface; SQLite and PostgreSQL moved onto it, unchanged | done in 0.2.0, with DuckDB |
| 2 | **Oracle**: `:1` placeholders, binary ordering (`NLSSORT(…, 'NLS_SORT=BINARY')`), NFC with `COMPOSE`, case folding and instant reading in PL/SQL (as `postgresFunctions` does), BOOLEAN from 23ai (else `NUMBER(1)`) | **Oracle stores `''` as NULL**, so "equals the empty string" can never match there: a documented deviation, to be decided |
| 3 | **SQL Server**: `@p1` placeholders, a `…_BIN2_UTF8` collation for code point order, `bit` booleans, `datetimeoffset` instants, `[` `]` escaped in LIKE patterns | **No NFC in T-SQL** (only through CLR functions, unavailable in Azure SQL): either a documented "store text in NFC" rule, or a server-side function, to be decided |

Testing without a server: both run locally in Docker, free for development and testing, spatial included. The
containers live outside the repository; the connections go in `demo-server/.env`; the tests skip, with the reason,
when a database isn't running.

| | Oracle | SQL Server |
|---|---|---|
| Edition | Oracle Database Free (23ai) | SQL Server 2022 Developer |
| Container | native arm64 and x86 (`gvenzl/oracle-free`, or Oracle's own image) | x86 only: on Apple Silicon, through Docker Desktop's Rosetta emulation |
| Memory | about 2 GB | at least 2 GB |
| Node driver (demo-server only) | `oracledb`, thin mode: plain JavaScript, no Oracle client | `mssql` (`tedious`): plain JavaScript |
| Loading the kitchen sink | a Node script (GDAL's Oracle driver needs Oracle's client libraries) | a Node script (GDAL's driver needs an ODBC driver) |
