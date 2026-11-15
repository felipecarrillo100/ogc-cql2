# Architecture

The design as of 1.0.0. For the reasons behind it, see [vision.md](vision.md).

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
Functions, Basic plus, Spatial Functions) in `validate` and `text`; `evaluate` (since 0.7.0) and every `sql` dialect
(PostGIS since 0.8.0, SQLite and DuckDB since 0.9.0) evaluate the two basic ones, `s_intersects`, and refuse Spatial
Functions (`unsupported`) until their engines arrive, see [spatial-research.md](spatial-research.md). `CASEI` and `ACCENTI` may each wrap the other once, as the
grammar allows (`CASEI(ACCENTI(name))`). Within them, the profile accepts the form every server must support: the standard lets a server accept
only a property on the left and a literal on the right (`/per/basic-cql2/cql2filter`,
`/per/advanced-comparison-operators/*`). So:

- `property op literal`, with `casei` around the property, the literal, or both;
- `like(property, pattern)`, `between(property, number, number)`, `in(property, [literals of one type])`;
- `isNull(property)`;
- `and` / `or` of two or more filters, `not` of one; `true`, `false`.

Since 1.2.0, Arithmetic Expressions: `+ - * / % div ^` wherever a number goes, computed with doubles (`div` toward
zero, `%` its remainder), a result that isn't a finite number NULL, expressions of literals computed once.

Since 1.3.0, Temporal Functions: the fifteen relations of instants and intervals, as OWL-Time defines them on the ends
(`src/core/temporal.ts`, one table for `evaluate` and every dialect). Intervals are closed, an instant is an interval
of zero length, `'..'` is the only open end; an instant in a relation of intervals only is refused, as the standard
says; dates and timestamps are never converted (an interval mixing them is refused); NULL for a NULL end or an
interval beginning after it ends. A literal first, or a property second, also needs Property-Property Comparisons.

Since 1.1.0, Property-Property Comparisons too: a property or a literal on either side of a comparison, as the bounds
of `between`, among the items of `in`, on the left of `like` (whose pattern stays a literal), and in either place of a
spatial function. A literal on the left is the property on the left, the operator mirrored, and a literal first in a
spatial function the converse relation, so every engine writes them as the portable form; two literals are decided
once. Two properties compare as their queryables say (`evaluate`'s `queryables` option, `toSql`'s columns).

## Entry points

Each part is its own entry point, with its own folder under `src/`. A part imports only what it needs, so a bundler
drops the rest.

| Import | Folder | Gives | Status |
|---|---|---|---|
| `ogc-cql2` | `src/` + `src/core/` | The profile's types (`Cql2Filter` …); `Cql2Error`; `CQL2_CONFORMANCE` (all of CQL2 1.0's filter classes, fixed) and `CONFORMANCE` (the ones implemented, a subset that only grows); `CQL2_VERSION` | 0.1.0 |
| `ogc-cql2/validate` | `src/validate/` | `validate`, `assertValid`, `requiredConformance`, `filterProperties` | 0.1.0 |
| `ogc-cql2/text` | `src/text/` | `toText`, `textProblem`, `isIdentifier`, `quoteString` | 0.1.0 |
| `ogc-cql2/evaluate` | `src/evaluate/` | `toPredicate`, `toEvaluator`, `evaluate`; `evaluateConformance` (the classes it supports with its options) | 0.1.0; 1.4.0: `evaluateConformance` |
| `ogc-cql2/sql` | `src/sql/` | `toSql` (CQL2-JSON → a parameterized `WHERE` clause), `sqlConformance` (the classes a dialect supports with its options), `sqliteFunctions`, `postgresFunctions`, `postgresValue`, `duckdbFunctions`, `duckdbValue` | 0.1.0: dialects `sqlite` and `postgres`; 0.2.0: `duckdb`; 1.4.0: `sqlConformance` |
| `ogc-cql2/parse` | `src/parse/` | `fromText` (CQL2-text → CQL2-JSON, then the profile check), for a server that receives text | 0.11.0 |

`text`, `parse`, `evaluate` and `sql` validate their input (or their result) first, so they load `validate` too.
`text` and `parse` share the grammar's lexical rules (`src/core/grammar.ts`: identifiers, keywords, whitespace, the
characters a string can hold).

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
  quotes, and so is one holding U+1680 (Ogham space mark), which the grammar puts in both `whitespace` and
  `identifierStart`: a reader taking it for a space would otherwise read another property. A name that isn't an
  `identifier` can't be written at all;
- **character literals:** in single quotes, with each quote doubled;
- **`LIKE` patterns:** written as they are; `%`, `_` and their escapes `\%`, `\_` are the standard's own;
- **backslashes:** Requirement 21 makes `\` the escape character in every literal and defines no escape for itself,
  so any other backslash in a string can't be written;
- **characters a string can't hold:** U+0000–U+0006, U+000E–U+001F, U+FFFE, U+FFFF and lone surrogates are outside
  the grammar's `character`, with no escape, so a string holding one can't be written. BEL, BS, tab, LF, VT, FF and
  CR are written as they are: the grammar allows them;
- **numbers:** with the grammar's exponent `E` (`1E+21`);
- **dates and timestamps:** `DATE('…')` and `TIMESTAMP('…')`;
- **AND / OR:** each operand in parentheses, so precedence never depends on the reader.

What the text can't express is refused as `not-expressible`, with the reason and the path. Nothing is approximated.

### Reading CQL2-text (`ogc-cql2/parse`)

`fromText(text, options?)` reads the whole grammar (`cql2.bnf`, tag `cql2-1.0.0`), every class, into CQL2-JSON, then
checks it with `assertValid` and the same options as `validate`. Valid CQL2 outside the profile is therefore refused
as it is in CQL2-JSON: `invalid-filter`, naming the class. Text that isn't CQL2-text is `invalid-text`, with
`details.position` (a UTF-16 index) and `details.expected`.

- **The reader:** a tokenizer and a hand-written recursive descent, one function per BNF rule, named as in the BNF
  (`src/parse/read.ts`, internal; `src/parse/index.ts` adds the profile check). One pass, no backtracking: a `(`
  opens a group or an array, decided by what follows. The whole text must be one `booleanExpression`; anything left
  over is refused.
- **What the grammar settles, read as it says:**
  - keywords are case-insensitive (ASCII letters only, as ABNF);
  - a keyword is always the keyword: a property named like one is written in double quotes, and only an identifier
    can be;
  - whitespace is the grammar's 25 characters, between any two tokens. U+1680 after a name is part of the name
    (it is also an identifier character);
  - Requirement 21's escapes: `''` and `\'` for a quote, `\a \b \t \n \v \f \r` for the control characters; in a LIKE
    pattern `\%` and `\_` stay as they are (the pattern's own escapes). Any other backslash, and a character outside
    `character`, is refused;
  - numbers as the grammar writes them (`1.`, `.5`, `+1`, exponents with `E` or `e`), read with `Number()` (exact to
    the nearest double: the same as correctly rounded conversion on 200,000 decimal strings);
  - `x NOT LIKE`, `x NOT BETWEEN`, `x NOT IN` and `x IS NOT NULL` are `{"op": "not", …}`, as the standard's JSON
    writes them; `BETWEEN` takes the next `AND`; one `NOT` per factor (`NOT (NOT …)` for two);
  - geometries as GeoJSON, `Z` optional (Requirement 26: the coordinates tell the dimension), `BBOX(…)` as `{bbox}`,
    `DATE` / `TIMESTAMP` with the grammar's shapes (UTC), `INTERVAL` with its parameters;
  - the standard's JSON names for its operators (`isNull`, `t_metBy`, `a_containedBy`, …); a custom function keeps the
    name it is written with.
- **What the grammar leaves open, refused rather than guessed:** `EMPTY` (`emptySet` is never defined),
  `MULTIPOINT(1 2, 3 4)` without each point's parentheses, `POINTZ`, `!=`, a timestamp with an offset.
- **Where the grammar has two readings:** `-1` is the number −1 (`signedNumericLiteral`); a minus before a property or
  a function is `{"op": "*", "args": [-1, x]}`, as other CQL2 parsers write it (CQL2-JSON has no unary minus).
- **Nesting:** 375 parentheses deep read (Node 24); deeper text overflows the call stack and is refused as
  `invalid-text`, not a crash.

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
  geometry's bounding box is computed once (cached per object) and tested first. `S_DISJOINT` is its negation.
- **The other relations (Spatial Functions, since 0.10.0)** need an engine the application plugs in
  (`spatialEngine`); without one the class is `unsupported`, `S_DISJOINT` included (with one, it stays the negation of
  the package's own `S_INTERSECTS`). The engine only computes DE-9IM matrices (`prepare(literal)`
  once per filter, then `relate(geometry)` per feature, the literal first). Their meaning lives in one place,
  `src/core/relate.ts`:
  - Simple Features' patterns (CQL2's Table 4 has a typo in S_TOUCHES' second matrix);
  - the dimension rules of S_OVERLAPS and S_CROSSES (a collection's dimension is its highest member's);
  - the transposition.
  So engines can't disagree on the meaning. The package keeps NULLs, values that aren't a geometry and empty
  geometries (the matrix `FFFFFFFF2`) from the engine, and an engine's error gives NULL. GEOS in WebAssembly (geos.js)
  is the engine recommended and tested; JSTS and turf were measured and not recommended (JSTS fails on collections,
  turf gives wrong answers). See [spatial-research.md](spatial-research.md).
- **Compiled once:** `toPredicate` and `toEvaluator` validate the filter and prepare its patterns and literals, so
  each feature costs only the comparisons.

### SQL (`ogc-cql2/sql`)

`toSql(filter, { dialect, columns })` returns `{ where, params }`: text and values only, no driver. The rule: the SQL
selects exactly the rows `evaluate` selects from the same values.

- **Always parameterized:** values are placeholders (`?` for `sqlite`, `$1`, `$2` … for `postgres` and `duckdb`, `:1`,
  `:2` … for `oracle`, `@p1`, `@p2` … for `sqlserver`), never text inside the query.
- **Property names are checked** against `columns` (the table's queryables), then quoted; anything else is
  `unknown-property`. A property can map to a column of another name.
- **CQL2's three-valued logic maps directly** onto SQL's NULL (`AND`, `OR`, `NOT`).
- **The pattern others use:** a field mapping and a function map, as pygeofilter's SQL backend does; unlike it, values
  are never put into the SQL text.
- **One walker, one file per dialect:** `toSql` (`src/sql/index.ts`) walks the filter; what differs per database is
  a `Dialect` (`src/sql/types.ts`), one file each in `src/sql/dialects/`: the placeholders, the boolean constants and
  the "no value can match" constant, the column's **view** for each kind of value (text, CASEI, number, boolean,
  day, instant), LIKE, and how boolean and instant literals are passed. A view can also convert the literal's value,
  wrap its parameter in an expression (`View.wrap`: Oracle's TO_BINARY_DOUBLE, SQL Server's scaled subnormals) and
  replace `view op param` with its own condition, which DuckDB's CASEI needs. Since 1.5.0 a dialect can also say that
  the database reads `''` as NULL (`emptyStringIsNull`: Oracle; the walker then decides comparisons with `''`), that it
  has no boolean values (`truth`: SQL Server, where a condition used as a value is written as 1 / 0 / NULL), and the
  default schema of its functions (`functionSchema`: SQL Server calls them by two-part name). The spatial hooks receive
  the function namer too.

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
| the other relations (since 0.10.0, `spatialite: true`) | `COALESCE(NULLIF(ST_<Rel>(GeomFromGPB(c), L), -1), CASE length(cql2_wkt(c)) WHEN 0 THEN 0 ELSE NULLIF(ST_<Rel>(GeomFromText(cql2_wkt(c), 4326), L), -1) END)`, `L` = `GeomFromText(?, 4326)` (WKT from `src/core/wkt.ts`; SpatiaLite's GeoJSON reader drops collections). SpatiaLite reads GeoPackage blobs itself (13× faster than through JavaScript on a million rows); `cql2_wkt`, the package's reader, takes what it can't (WKB, extended WKB, empty collections), an empty geometry FALSE (SpatiaLite can't represent one); its −1 ("can't compute") is NULL. The R-tree first, outside a NOT. `s_disjoint`: `NOT (s_intersects)` |
| `s_intersects` (since 0.9.0) | `cql2_intersects(c, $json) = 1` on a geometry column (`format: "geometry-…"`): a GeoPackage blob or WKB decoded (`src/sql/wkb.ts`) and tested by `evaluate`'s engine, after the header envelope's quick reject. With `rtree` (GeoPackage's R-tree table) and only outside a NOT: `rowid IN (SELECT id FROM rtree WHERE <boxes overlap>) AND …` first |

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
| `s_intersects` (PostGIS, since 0.8.0; this form since 0.9.1) | `geom && literal AND NOT ST_Relate(geom, literal, 'FF*FF****')`, the literal as `ST_SetSRID(ST_GeomFromGeoJSON($n), 4326)` or `ST_MakeEnvelope(…)` (across the antimeridian two, joined with OR: PostgreSQL's BitmapOr keeps the index; one multipolygon spanning the world is 4–5× slower); a GeometryCollection literal member by member (GEOS 3.11's `ST_Relate` refuses collections). `&&` uses the GiST index, DE-9IM's "disjoint" pattern decides from GEOS's full matrix. Neither `ST_Intersects` nor `ST_Disjoint`: PostGIS answers them for a point and a polygon with its own point-in-polygon test, whose side test arm64 compilers turn into a fused multiply-add, so it misses points exactly on an edge (`ST_Intersects` always on arm64, `ST_Disjoint` from PostGIS 3.7). Measured on PostGIS 3.1–3.7 (GEOS 3.9–3.15), amd64 and arm64: 0 of 5,805 literals differ from `evaluate`; the 0.8.0 form, on 3.7.0 arm64, 99. As fast as `ST_Intersects` with the index (under 0.1 ms for a small box, about 22 ms for a 40-vertex polygon on a million rows), 10–25% slower on a quarter of the world. Another SRID: the column transformed to 4326, fast with an expression index on `ST_Transform(geom, 4326)`; geography as `::geometry`, fast with one on `(geog::geometry)` (both measured: a full scan without) |
| the other relations (PostGIS, since 0.10.0) | `ST_Equals(g, L)`; `g && L AND ST_Touches / ST_Overlaps / ST_Crosses(g, L)`; `g @ L AND ST_Relate(g, L, 'T*F**F***')` (S_WITHIN) and `g ~ L AND ST_Relate(g, L, 'T*****FF*')` (S_CONTAINS): `ST_Within` and `ST_Contains` take the point-in-polygon shortcut (plain `ST_Contains` measured wrong for 26 of 1,527 literals on every arm64 server). A box across the antimeridian `ST_Collect` of the halves. `s_disjoint`: `NOT (s_intersects)`, which no index speeds up. Measured on PostGIS 3.1–3.7, amd64 and arm64: 0 differences from `evaluate` with GEOS |

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
| numbers | `CAST(c AS DOUBLE)` against `$n::DOUBLE`, the number bound as its text (since 0.9.0, see below) |
| booleans | `c` against `$n::BOOLEAN` |
| text | `nfc_normalize(c) COLLATE "binary"`: code point order, whatever the database's `default_collation` (`nocase` would make `'a' = 'A'` true) |
| text against a `DATE` / `TIMESTAMP WITH TIME ZONE` / `TIMESTAMP` column | the served text, through `strftime` |
| `casei(…)` | `cql2_casei_cmp(c, $n) op 0`; `IN` as `= 0` conditions joined with `OR`; LIKE as `cql2_casei_like(c, $n) = 1` |
| `accenti(…)`, and nested with `casei` | `cql2_fold_cmp(c, $n, 'accenti,casei') op 0` and `cql2_fold_like(…) = 1`, the folds named innermost first. DuckDB's `strip_accents` differs from the standard's rule on 548 code points (Indic spacing vowel signs, enclosing marks, the Japanese voicing marks: measured over every code point), so it isn't used |
| `{date}` | `c` against `$n::DATE` on a `DATE` column; `cql2_day(c)` (days since 1970) on text |
| `{timestamp}` | `floor(epoch_us(c) / 1000)` (epoch milliseconds, truncated: `epoch_ms` rounds) on `TIMESTAMP WITH TIME ZONE`; from `cql2_instant_day` and `cql2_instant_ms` on text; NULL on `TIMESTAMP` |
| `like` | native `LIKE … ESCAPE '\'` (case-sensitive, `_` one code point) on the NFC text; a lone trailing `\` becomes a literal one |
| `s_intersects` (since 0.9.0, the spatial extension) | `ST_Intersects(g, L)`, as DuckDB documents it, on a `GEOMETRY` column or on `TRY(ST_GeomFromWKB(c))` for a `BLOB` of WKB; `L` = `ST_GeomFromGeoJSON($n)` or `ST_MakeEnvelope(…)`, across the antimeridian `ST_Union` of the two halves (one literal, so an R-tree index still applies). With `SqlColumn.covering` (GeoParquet's bbox covering), outside a NOT: its four fields compared first, the box rounded outward to 32-bit floats |
| the other relations (since 0.10.0) | `ST_Equals`, `ST_Touches`, `ST_Within`, `ST_Overlaps`, `ST_Crosses`, `ST_Contains` (g, L): exact on DuckDB 1.4.3, 1.5.4 and 2.0 and in DuckDB-WASM 1.32.0 and 1.33.1 (no `ST_Relate` there), each using the R-tree; the covering's overlap comparisons first, outside a NOT; `s_disjoint`: `NOT (s_intersects)` |

`duckdbFunctions` are plain JavaScript functions with their DuckDB types, registered on the connection by the
application (`registerScalarFunction` in Node, `createScalarFunction` in DuckDB-WASM's blocking build, run in a Web
Worker). **They all return 32-bit integers**, the one result type DuckDB-WASM (1.32.0, and 1.33.1-dev110) passes back
exactly from JavaScript: text comes back as zero bytes, DOUBLE as a 32-bit float, BIGINT cut to 32 bits, and BOOLEAN
is refused. So CASEI compares inside the function, and an instant read from text is its UTC day plus the
milliseconds into that day. Nothing depends on the time-zone setting: instants are compared as numbers.

**Numbers are bound as text (0.9.0).** DuckDB-WASM 1.32.0 (DuckDB 1.4.3) binds a JavaScript number that needs all 17
significant digits one unit off, about one in ten of them (2,000 random values per kind: 233 coordinates, 217 values
in 0…1, 169 around 1e15; none with two decimals, no integer): `0.9653517007827759` becomes `0.965351700782776`, as if
printed with 16 digits. A SQL literal of 17 digits (a DECIMAL) is read one unit off the same way. Text cast to DOUBLE
was exact in all 10,000 cases, and Node is exact. So number parameters are their JavaScript text (`String(n)`, which
reads back exactly). This affected 0.2.0–0.8.0 in the browser; the 0.2.0 check missed it, its numbers being short.

**Spatial, measured (0.9.0)**, on a million rows (points and small squares), in Node:

| SQLite form | small box | quarter of the world | 40-vertex polygon |
|---|---|---|---|
| `cql2_intersects`, GeoPackage blobs with the header envelope | 811 ms | 1.4 s | 3.6 s |
| the same without the envelope | 2.9 s | 2.8 s | 7.1 s |
| the same, with GeoPackage's R-tree first | 3 ms | 0.9 s | 57 ms |

DuckDB, the SQL `toSql` writes, on each engine: DuckDB 2.0 (Node), DuckDB 1.4.3 (Node), and DuckDB-WASM 1.32.0
(DuckDB 1.4.3, Chrome); small box / quarter of the world / 40-vertex polygon:

| Data | 2.0, Node | 1.4.3, Node | DuckDB-WASM, Chrome |
|---|---|---|---|
| `GEOMETRY`, random order, no index | 156 / 137 / 140 ms | 157 / 160 / 145 ms | 617 / 642 / 621 ms |
| the same with an R-tree index | 1 / 138 / 2 ms | 1 / 174 / 5 ms | 1 / 281 / 12 ms |
| random order, with a covering | 5 / 37 / 5 ms | 54 / 57 / 34 ms | 71 / 238 / 77 ms |
| sorted by `ST_Hilbert`, with a covering | 1 / 35 / 4 ms | 2 / 49 / 4 ms | 5 / 188 / 13 ms |
| `BLOB` of WKB, sorted, with a covering | 6 / 42 / 9 ms (Parquet) | not measured | 5 / 263 / 16 ms |
| `BLOB` of WKB, sorted, no covering | 136 / 137 / 144 ms (Parquet) | not measured | 941 / 953 / 948 ms |

- **Why not `ST_Intersects AND ST_Intersects_Extent`:** on DuckDB 2.0 it is 9 / 36 / 15 ms without an index. On
  DuckDB 1.4.3, the browser's engine, it is no faster than `ST_Intersects` alone (162 / 153 / 142 ms), and it loses
  the R-tree index (164 / 147 / 137 ms with one). Nobody else writes it. `ST_Intersects(g, L)` alone is what DuckDB's
  documentation, rustac and cql2-rs write. A data source made fast (an index, a covering, rows sorted spatially) is
  fast on every engine.
- **The covering** is what Overture's documentation and Martin (MapLibre's tile server) write: the comparisons first,
  then `ST_Intersects`. DuckDB 2.0 doesn't use a GeoParquet 1.1 covering by itself: on a 730 MB Overture places file
  read over HTTP, `ST_Intersects` alone read all 256 row groups (18.7 s), and with the comparisons 11 (1.9 s). Bound
  `$n::DOUBLE` parameters are pushed into the Parquet scan like literals (DuckDB 2.0). Only outside a NOT: a value whose box
  survived but that isn't a geometry would give FALSE there instead of NULL.
- **Exactness:** DuckDB's `ST_Intersects`, alone or after the covering's comparisons, gives the same states as
  `evaluate` for all 5,705 literals of `demo-server/test/spatial.test.ts`, on `GEOMETRY` and `BLOB` columns, in Node
  (with and without the index) and in DuckDB-WASM. SQLite runs `evaluate`'s engine, so it is exact by construction;
  the tests check the decoding.
- **The R-tree and NOT:** GeoPackage's R-tree holds no NULL or empty geometries, so a prefilter on it gives FALSE where
  `evaluate` gives NULL. In three-valued logic, a condition that is TRUE with a NULL leaf is TRUE with FALSE there too,
  and only NOT turns FALSE into TRUE, so the prefilter selects the same rows for a leaf under an even number of NOTs.
  `toSql` passes that to `Dialect.intersects`; under a NOT the function alone decides. Every exact form that keeps
  the prefilter under a NOT was measured and lost the speed (0.8–3.3 s).
- **No JavaScript function in DuckDB:** DuckDB-WASM hands a BLOB to one as UTF-8-decoded text (each byte ≥ 0x80
  becomes U+FFFD), so WKB can't reach it; passing it as hex works in both runtimes but costs 50% more in Node, on a
  path a hundred times slower than the extension. DuckDB's spatial filters need the extension, which loads in
  DuckDB-WASM.

**DuckDB: what we rely on.** DuckDB's spatial support is moving fast (GEOMETRY moved into its core in 1.5, with
statistics per row group), and DuckDB-WASM ships an older engine than Node. So the spatial tests run on both engines
(`test/sql-spatial-duckdb.test.ts`, `test/sql-spatial-duckdb-1.4.test.ts`; a process loads one DuckDB, hence one file
each), and canaries state what the dialect relies on. Each fails when a DuckDB release changes it:

| Canary | When it fails |
|---|---|
| plain `ST_GeomFromWKB` fails the query on bytes that aren't WKB | `TRY(…)` may go |
| DuckDB 2.0 and later fail on a covering for a table with an R-tree index (1.4 and 1.5 answer it) | lift the limitation (`SqlColumn.covering`, README) |
| DuckDB 2.0 skips no row group of a GeoParquet 1.1 file from its covering by itself | the covering's comparisons may become unnecessary |
| on DuckDB 2.0, `ST_Intersects` alone is more than 3× slower than with `ST_Intersects_Extent`, without an index (a timing: it only reports the ratio, and fails on it only with `CQL2_CANARY_TIMING=1`, so the machine's load can't fail a test run. The 3× is macOS's: Linux arm64 measured 1.2–1.9× on 2026-11-01, on DuckDB 1.5.4 and 2.0, so the weekly CI run only reports it) | the gap closed: no engine option needed. If it persists through releases, it is the evidence for an explicit engine option (none is planned; `toSql` never sees the connection, and the runtime isn't the engine version) |

When DuckDB-WASM ships a newer engine, the `@duckdb/node-api-1.4` devDependency moves to that engine.

**`npm run check:duckdb`** (`scripts/check-duckdb.mjs`) runs the same suite on the newest engines, before a release or
monthly: the newest `@duckdb/node-api`, and the engine inside the newest DuckDB-WASM (`latest` and `next`, read
through the package's own Node build), each through the `@duckdb/node-api` of that engine. It installs them in a
temporary folder (never package.json or the lock file), holds each to its line's expectations (`1.4`, or `core` from
1.5), enforces the timing canary's threshold, and prints each test with what to update when one fails; it exits
with 1 then. An engine without a Node package (a development build) is reported, not tested. On 2026-10-31 it found
DuckDB-WASM's `latest` (1.33.1-dev57.0) shipping DuckDB 1.5.4, which passes everything except the covering on an
indexed table: that works there, so the failure is DuckDB 2.0's alone. Its profile doesn't count row groups, so the
canary on the covering can't tell there. Measured on 2026-11-01: with a covering on an R-tree-indexed table, DuckDB
1.5.4, 1.5.6 and DuckDB-WASM 1.33.1-dev57.0 select what `evaluate` selects for every spatial filter, still through the
index; 2.0.0 still fails. The canary expects the failure from DuckDB 2.0 on only.

The `oracle` dialect (since 1.5.0), for Oracle Database 23ai and later (it needs SQL's BOOLEAN), with Oracle Spatial:

| CQL2 | Oracle |
|---|---|
| `true` / `false`, no value can match | `TRUE` / `FALSE`, `CAST(NULL AS BOOLEAN)` |
| text | the column as it is, the parameter `COLLATE BINARY` (code point order whatever `NLS_COMP` / `NLS_SORT`, and the index kept); NVARCHAR2 through `TO_CHAR` |
| a comparison with `''` | decided when the SQL is built (`v <> v` or `v = v`): Oracle reads `''` as NULL, so no column holds it |
| numbers | `TO_BINARY_DOUBLE(c)` against `TO_BINARY_DOUBLE(:n, '9D…EEEE', 'NLS_NUMERIC_CHARACTERS=''.,''')`, the literal as `toExponential()` text |
| `like` | `c LIKE :n COLLATE BINARY ESCAPE '\'`, the pattern rewritten (Oracle refuses an escape before anything but `%`, `_`, `\`) |
| `casei`, `accenti` | `cql2_casei`, `cql2_accenti` (PL/SQL, `oracleFunctions`): NFD, fold or remove, NFC, with the package's tables, not Oracle's `COMPOSE` (which never composes across a mark) or `DECOMPOSE` alone (which leaves marks above U+FFFF out of order) |
| `{date}` | a DATE with `format: "date"` as `TO_CHAR(c, 'YYYY-MM-DD')`, a year before 1 NULL (`View.finite`); text through `cql2_day` |
| `{timestamp}` | a TIMESTAMP WITH (LOCAL) TIME ZONE as UTC text truncated to milliseconds (Oracle's date arithmetic is Julian before 1582; the text orders right in both calendars); text through `cql2_instant` |
| arithmetic | `+ - * / div` in BINARY_DOUBLE, a NaN or infinite result NULL; `%` and `^` through `cql2_arithmetic` (written inline, they would repeat their operands, and Oracle binds each placeholder it reads) |
| the spatial relations | `cql2_relate(rel, column, literal) = 1`: one `SDO_GEOM.RELATE(…, 'DETERMINE', …)` with SRID NULL and tolerance 1e-10, then the dimensions (for two lines, of their intersection); the literal built exactly by `cql2_geometry` (Oracle's GeoJSON keeps 15 digits). With `spatialIndex`, outside a NOT: `SDO_FILTER(cql2_planar(column), literal)` first, a planar function-based index (the 4326 index is geodetic, and loses planar candidates) |

The `sqlserver` dialect (since 1.5.0), for SQL Server 2022 and later, with Basic Spatial Functions:

| CQL2 | SQL Server |
|---|---|
| `true` / `false`, no value can match | `1 = 1` / `1 = 0`, `1 = NULL`; a condition used as a value: `CASE WHEN c THEN 1 WHEN NOT (c) THEN 0 END`, compared with 1 |
| text | `CAST(CONVERT(varchar(max), x COLLATE Latin1_General_100_BIN2_UTF8) AS varbinary(max))` on both sides: code point order without blank padding (SQL Server compares `'a' = 'a '` as TRUE); the index lost |
| numbers | `CAST(c AS float)` against `CAST(@p AS float)`, the literal as text; a subnormal one bound ×2^54 and scaled back (SQL Server reads its text as 0) |
| `like` | without `_`: `CONVERT(varchar(max), (c + N'\|') …) LIKE CONVERT(varchar(max), (@p + N'\|') …) ESCAPE '\'` (`[` escaped; the `\|` keeps the trailing blanks LIKE ignores); with `_`: `cql2_like` (SQL Server's `_` isn't one code point) |
| `casei`, `accenti` | `cql2_casei`, `cql2_accenti` (T-SQL, `sqlserverFunctions`): the package's own NFD, reordering, fold or removal and NFC, set-based on code points |
| `{date}` | a `date` as a date (`CAST(@p AS date)`, the index kept); text through `cql2_day` |
| `{timestamp}` | a `datetimeoffset` as `DATEDIFF_BIG(millisecond, …)` in UTC (truncated); text through `cql2_instant` |
| arithmetic | `cql2_arithmetic`: overflow decided from the operands' exponents (the float's bits) before any operation, since SQL Server would fail the whole query |
| `s_intersects` | `(c.STIsEmpty() = 0 AND c.STDistance(L) <= 0)`, `L` from WKB in the column's SRID; the spatial index applies. The other relations aren't translated: SQL Server's grid differs from GEOS on boundaries |

### Errors

- **Every refusal throws a `Cql2Error`:** `invalid-filter` (from `assertValid`, and from `text` and `evaluate` for an
  invalid input, and from `fromText` for valid CQL2 outside the profile), `not-expressible` (from `toText`),
  `invalid-text` (from `fromText`: not CQL2-text; `details.position`, `details.expected`), `unknown-property` (from
  `toSql`, for a property not in `columns`) or `unsupported`, with a message, the path inside the filter and
  `details`.
- **Callers test the `code`, not `instanceof`.** That keeps working even when two copies of the package end up in one
  application.

### Stability

What 1.0.0 keeps stable, and what minor versions add as the package grows, is the README's "Versioning and
stability". The design follows from it:
- **A new class widens; it never moves or removes anything.** `Cql2Filter`, its arguments, the problem and error
  codes and `CONFORMANCE` gain members; `CQL2_CONFORMANCE` is fixed from the start, which is why there is no list of
  the classes not implemented (it would lose a key with each class).
- **The internals stay free:** the SQL dialect interface (`src/sql/types.ts`) and everything else not exported can
  change in any version.

## Deviations, deliberate

Where the standard leaves a choice, or recommends without requiring, the package's choice and why.

| Point | The standard | The package | Why |
|---|---|---|---|
| Unicode normalization form | strings SHOULD be normalized before comparing, and NFD is the recommended form (Recommendation 1, `/rec/core/string-normalization` B) | normalizes, to **NFC** | the same answers for `=`, `<>`, `IN` and CASEI (canonically equivalent forms); NFD would reorder 0.8% of string pairs in the tests' data (`<`, `>`…) and break LIKE's `_` on accented letters (`'caf_'` would no longer match `café`, as `é` is two code points in NFD); NFC is the W3C's form for string matching on the web and how data is stored; DuckDB has no NFD |
| Instants' precision | left to the server ("how this is implemented is a decision of the server") | milliseconds, a finer fraction truncated | JavaScript's precision; every engine (SQLite, PostgreSQL, DuckDB) is made to truncate the same way, so the results agree |
| Numbers that aren't finite (NaN, ±Infinity) in the data | no literal for them (`validate` refuses one as `invalid-number`); nothing about values | ordered as SQL orders them, the same in every engine: NaN above every number, ±Infinity at the ends | measured 2026-10-31 with NaN and ±Infinity rows in the SQLite and DuckDB tests and a check in PostgreSQL: 0 of 27,487 filters differ, so nothing is converted. A server that sends them as JSON sends `null` (JSON has no NaN), which a client re-filtering what it received reads as NULL |
| Infinite dates and timestamps in the data (PostgreSQL, DuckDB's DATE) | no such instant (`'..'` is only a literal) | NULL in comparisons, the same in every engine (since 1.3.0); served as the text `infinity`, so not NULL for `isNull` | `evaluate` reads the served text as no date, so SQL must too; on a DATE column the check is `(d op $1 AND isfinite(d))` (`OR NOT isfinite(d)` under a NOT), which keeps PostgreSQL's B-tree index where a `CASE` lost it (10M rows: about 20 ms against 400 ms, measured on PostgreSQL 14 and 18) |
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
  - and, if it must accept CQL2-text, reads it (`ogc-cql2/parse`).

## The demo server (`demo-server/`, not published)

A Node backend (Express 5) that answers the playground's filters from data files, through a **store layer**: one
store per collection, each answering the same three questions (describe yourself, your queryables, the features a
filter selects). The server never knows which store it talks to.

| Store | Reads | Filters with | Status |
|---|---|---|---|
| GeoJSON | one FeatureCollection file, read once at startup | `ogc-cql2/evaluate` | 0.1.0 |
| GeoPackage (SQLite) | the `features` and `attributes` tables a GeoPackage lists in `gpkg_contents` (Node's built-in `node:sqlite`, read-only) | `ogc-cql2/sql` | 0.1.0 |
| PostgreSQL / PostGIS | the tables `collections.json` lists (never discovered); the connection in a git-ignored `.env` | `ogc-cql2/sql`, `postgres` dialect | 0.1.0 |
| GeoParquet (DuckDB) | the Parquet files `collections.json` lists, read in place with `@duckdb/node-api` | `ogc-cql2/sql`, `duckdb` dialect | after 1.0.0 |
| Oracle | the tables `collections.json` lists; the connection in `.env` (`oracledb`, thin mode) | `ogc-cql2/sql`, `oracle` dialect | 1.5.0 |
| SQL Server | the tables `collections.json` lists; the connection in `.env` (`mssql`) | `ogc-cql2/sql`, `sqlserver` dialect | 1.5.0 |

- A GeoPackage table: the id is its INTEGER primary key (Req 29, 119), the queryables come from its declared types
  (Table 1), BOOLEAN 0 / 1 is served as `false` / `true`, and geometry is decoded from GeoPackageBinary (the `GP`
  header, then WKB) to GeoJSON. A table not in WGS 84 is served without geometry, and that's reported.
- A PostgreSQL table: the id is its primary key (or `id` in the config), the queryables come from the declared types,
  values are selected through `postgresValue`, and a PostGIS geometry is read as WKB, converted to WGS 84 with
  `ST_Transform` when needed.
- A GeoParquet file: the id is a column (`id`, or `idColumn` in the config), unique and never NULL; the queryables
  come from the column types; values are selected through `duckdbValue`; the geometry is the `geo` metadata's primary
  column, read as WKB. A file not in WGS 84, or with spherical edges, is served without geometry, and that's reported.
  The file's bbox covering (GeoParquet 1.1) goes to `toSql`. Spatial filters need DuckDB's spatial extension; without
  it the spatial classes aren't declared. The files are made by GDAL (`data/make-parquet.sh`), which keeps every
  value of the kitchen sink.
- Each store declares the classes its engine reports: `evaluateConformance({ spatialEngine })` with GEOS for a GeoJSON
  file, `sqlConformance` with the dialect's options for the others (a GeoPackage with SpatiaLite or without; DuckDB
  without the spatial classes when its extension didn't load, a rule its worker in the playground shares,
  `duckdbConformance` in `duckdb-columns.ts`). They are listed with each collection (`conformance`, a demo field), and
  the playground ticks them as the source's classes.
- Every store answers GeoJSON features. A GeoJSON file's ids are kept when unique; missing ones are generated
  deterministically (the position in the file, or after the largest numeric id); a duplicate id drops the later
  feature, which is reported.
- The server validates each filter (`validate`), checks its properties against the collection's queryables
  (`filterProperties`), and refuses with HTTP 400 and `application/problem+json`. A filter sent with
  `"filter-lang": "cql2-text"` is read with `fromText`, with the same checks; text that isn't CQL2-text is refused as
  `invalid-text`, with its position.
- Only the server has dependencies (Express, `pg` for PostgreSQL, `@duckdb/node-api` for GeoParquet; SQLite is
  Node's built-in `node:sqlite`). The
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
  - every other one is refused only as `outside-profile` or `unknown-operator`, naming a conformance class;
  - **the 120 standard text examples** (109, and 11 other texts of them) are read by `fromText` exactly as their JSON
    example (three of them write an instant with `.000000` in the text and without in the JSON, compared without the
    zero fraction); those in the profile come out of `fromText` and read back through `toText`; the others are
    refused only as outside the profile.
- **The grammar:** identifier, keyword, escaping and number cases taken from the BNF, for writing (`test/text.test.ts`)
  and reading (`test/parse.test.ts`: every reading rule, each refusal with its position).
- **Round trips:** `fromText(toText(f))` gives `f` exactly, on the DuckDB test's generated filters for property names
  that are keywords, hold a colon or U+1680 (over 10,000), and on the spatial tests' filters. cql2-rs reads the same
  texts as the same filters (but for U+1680, which it takes for a space, and refuses quoted).
- **Truth tables:** every operator against a matching value, a non-matching value, a null and a missing property;
  `AND` / `OR` / `NOT` as the standard's tables; case-folding cases; strict dates and instants.
- **SQL against real databases (differential tests):**
  - `test/sql.test.ts`: 12,984 generated filters on a SQLite table of awkward values (NULLs, values of an unexpected
    type, NFC and NFD, code points above U+FFFF, LIKE's special characters) select the same rows as `evaluate`;
  - `test/sql-duckdb.test.ts`: 24,661 generated filters on a DuckDB table (`@duckdb/node-api`, a dev dependency, in
    the test process) select the same rows as `evaluate` on the served values, also with `default_collation` set to
    `nocase` and a New York time zone;
  - the same filters in **DuckDB-WASM**, in Chrome: run for 0.2.0 and again for 0.5.0 (24,136 filters, 9,639 of them
    with ACCENTI) with a harness outside the repository (the same table and filters, the README's registration code,
    Vite's build), with the same result. The browser carries an
    older engine (DuckDB 1.4.3, against 2.0 in Node), so passing in Node doesn't prove the browser;
  - `demo-server/test/stores-agree.test.ts`: on the kitchen sink, 10,016 generated filters give the same features from
    the GeoJSON file, the GeoPackage, the GeoParquet file (DuckDB, with GDAL's float32 bbox covering) and PostgreSQL
    (when the database is set up; skipped otherwise), and so do the spatial literals and the seven other relations;
  - `test/naturalearth.test.ts`: the standard's own acceptance test for Basic Spatial Functions (Table 12, conformance
    test 26) on Natural Earth 1:110m (public domain, `test/fixtures/naturalearth/`): all eight counts;
  - `test/engine-conformance.test.ts` (1.4.0): `evaluateConformance` and `sqlConformance` for each option set, and
    their promise on 6,525 filters (the standard's examples, spatial literals under every relation, the corpora): each
    filter compiles exactly when it validates against the list, and is otherwise refused as `unsupported`;
  - `test/temporal.test.ts` (1.3.0): the standard's 72 temporal rows (Annex A's, and Table 16's) on its test data, in
    `evaluate` and SQLite, and in `test/duckdb-spatial.ts` on DuckDB 2.0 and 1.4.3; 17,394 generated temporal filters
    against `evaluate` in `test/sql.test.ts` and `test/sql-duckdb.test.ts` (rows of ±infinity in DuckDB), and on the
    kitchen sink's `at` and `until` in the four stores;
  - `demo-server/test/spatial.test.ts`: S_INTERSECTS on the US states against GEOS (PostGIS's `NOT ST_Disjoint`), 5,705
    generated literals, many exactly on the states' vertices and edges: the same states. PostGIS's own
    `ST_Intersects` isn't the reference: its shortcut for a point in a polygon isn't exact for a point exactly on an
    edge (109 point-state pairs where it says false and GEOS's DE-9IM matrix puts the point on the boundary, measured
    on PostGIS 3.5.6); the test checks that every departure is such a point. This matters for the PostGIS dialect;
  - the same 5,705 literals through `toSql` (`postgres`) and demo-server's PostgreSQL store: the same states as
    `evaluate`; the four-store comparison has spatial filters too, from GeoJSON and PostgreSQL in 4326 (also exactly on
    vertices) and in 3857 (with margin: 58 of 141 literals placed exactly on the original vertices differ there,
    because the stored 3857 coordinates don't convert back exactly), and since 0.9.0 from the GeoPackage, whose store
    also runs the 5,705 literals (through GeoPackage's R-tree);
  - `test/sql-spatial.test.ts` (0.9.0): 132 spatial filters, nested NOTs among them, in SQLite on GeoPackage blobs
    with and without the envelope, WKB, big-endian extended WKB, and with GeoPackage's R-tree, with empty geometries,
    NULL, text, bytes that aren't a geometry, and coordinates no 32-bit float holds: the same rows as `evaluate`;
  - `test/duckdb-spatial.ts` (0.9.0), once on DuckDB 2.0 and once on DuckDB 1.4.3 (DuckDB-WASM's engine): the same 132
    filters on `GEOMETRY` and `BLOB` columns, each without a covering and with `DOUBLE` and `FLOAT` covering fields
    (values whose box survived without a geometry among them); the R-tree index used (`EXPLAIN`) for a box, a
    geometry parameter and the antimeridian; and the canaries of "DuckDB: what we rely on"; `npm run check:duckdb` runs
    it on the newest DuckDB engines (not part of `npm test`);
  - PostgreSQL's `cql2_accenti` against the JavaScript rule on every code point of the Basic Multilingual Plane
    (63,487) for 0.5.0: no difference;
  - each rule was broken once on purpose, to show the tests catch it.
- **Independent checks,** not part of the repository or of the package:
  - two other CQL2 parsers (cql2-rs, pycql2) read the text output back to the same CQL2-JSON. For 0.11.0, pycql2
    0.2.0 read 7,957 of the round trip's texts: every disagreement is pycql2's (it refuses characters above U+FFFF
    and private-use characters, which the grammar allows, and rewrites timestamps to six fraction digits);
  - `fromText` in Chrome 156 (headless, a page built with Vite), for 0.11.0: the 120 standard text examples, exact;
  - **cql2-rs's evaluator** (Development Seed; `cql2` on PyPI, about 200,000 downloads a month, and `cql2-wasm` on
    npm, version 0.5.6), 2026-10-31: the DuckDB test's 11,050 filters on its 15 rows, 165,750 answers. 46% agree;
    52% are errors in cql2-rs (a type mismatch, which the standard lets it refuse; a missing property, where the
    standard requires NULL); 2% differ, all explained by the standard: dates and timestamps compared with each other
    (cql2-rs casts), CASEI (cql2-rs lowercases instead of the required full Unicode case folding: `Straße` vs
    `STRASSE`), `IN` with dates or timestamps (a bug in cql2-rs: its `=` agrees), normalization (cql2-rs has none),
    and precision below a millisecond. No bug of `ogc-cql2` was found. Both accept the same 47 of the standard's 109
    examples (those in the profile).
- **CI** (GitHub Actions, checks only: it never publishes, and there is no npm token on GitHub):
  - **`.github/workflows/ci.yml`,** on every push to `main` and every pull request:
    - typecheck, the tests (SpatiaLite included), the build (attw, publint), `check:imports`, `check:bundle` and the
      playground's build, on Node 22 and 24, Linux amd64 and arm64 (`ubuntu-26.04`, `ubuntu-26.04-arm`);
    - demo-server's tests against PostgreSQL + PostGIS (`imresamu/postgis:18-3.6`, multi-arch: the official
      `postgis/postgis` image is amd64 only), loaded with `data/load-postgres.sh`.
    - Ubuntu 26.04, because 24.04's SpatiaLite is built with GEOS 3.12, older than the 3.13 that GeometryCollection
      literals need.
  - **`.github/workflows/duckdb.yml`:** `check:duckdb` every Monday, and by hand. A failed run says what to update,
    e.g. when DuckDB 2.0 no longer fails on a covering on an R-tree-indexed table (duckdb-spatial #906).
  - **Local, before a release:** the PostGIS version matrix (PostgreSQL 13–18, PostGIS 3.1–3.7, amd64 and arm64), the
    Chrome checks (DuckDB-WASM, `fromText`) and mutations.

## Build and tooling

| Job | Tool |
|---|---|
| Build | tsdown: ESM, one output file per source module (`unbundle`), `.d.ts` files generated with `isolatedDeclarations` |
| Package checks | publint and arethetypeswrong, run with every build |
| Typecheck | TypeScript 7. `tsconfig.json` checks `src/` without DOM types, so the sources also run in Node; `tsconfig.dev.json` checks the tests, the demo and the config files |
| Tests | Vitest, with ajv and the official JSON Schema (development only) |
| Demo | Vite: the playground, importing the package by name, aliased to `src/` |
| Case folding | `node scripts/gen-case-folding.mjs <CaseFolding-15.0.0.txt>`, run when the Unicode version changes |
| Normalization, for the `oracle` and `sqlserver` CASEI and ACCENTI (since 1.5.0) | `node scripts/gen-composition.mjs <UnicodeData.txt> <CompositionExclusions.txt>` (Unicode 15.0.0): `src/sql/dialects/composition.ts`, the primary composites, the combining classes and the canonical decompositions |
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
| 0.8.0 | **Spatial, phase C:** `s_intersects` in the `postgres` dialect (PostGIS), exact and indexed |
| 0.9.0 | **Spatial, phase D:** `s_intersects` in the `sqlite` dialect (GeoPackage, `evaluate`'s engine as a function, GeoPackage's R-tree outside a NOT) and the `duckdb` dialect (the spatial extension's `ST_Intersects`, exact, indexed; GeoParquet's bbox covering outside a NOT; tested on DuckDB 2.0 and 1.4.3); DuckDB's numbers bound as text, for DuckDB-WASM |
| 0.9.1 | PostGIS `s_intersects` decided by GEOS's matrix (`ST_Relate`), exact on arm64 and PostGIS 3.7; `npm run check:duckdb` |
| 0.10.0 | **Spatial Functions** (the other seven relations, DE-9IM): an engine hook in `evaluate` (GEOS through geos.js recommended), PostGIS, DuckDB, and **SpatiaLite** as an option of the `sqlite` dialect; the standard's Table 14 on full-precision Natural Earth; one reference, GEOS; the README's Tested versions |
| 0.11.0 | **`ogc-cql2/parse`:** `fromText`, CQL2-text → CQL2-JSON (the whole grammar, then the profile check), for servers implementing OGC API Features Part 3, where `filter-lang=cql2-text` is the default; its own entry point, so web apps don't load it; tested on the standard's 120 text examples, on reading back `toText`'s output, and against cql2-rs and pycql2. `toText` refuses characters a string can't hold and quotes names holding U+1680. demo-server accepts text filters |
| 0.12.0 | **Before the freeze:** Node 22 or later (Node 20's end of life); `CQL2_CONFORMANCE` (all twelve filter classes, fixed) in place of `OTHER_CONFORMANCE`; the stability policy (README, "Versioning and stability") |
| 1.0.0 | **The API freeze:** 0.12.0's API, kept stable under the README's "Versioning and stability"; CI (GitHub Actions) runs the proof routine on every push, and the newest DuckDB engines weekly |
| after 1.0.0 (demo only, not published) | GeoParquet files (made by GDAL) and a DuckDB store in `demo-server`, the kitchen sink giving the same features from four stores; the same files filtered in the playground by DuckDB-WASM, with the store's own SQL, on desktop and on phones |
| 1.1.0 | **Property-Property Comparisons:** a property or a literal on either side, in every part and engine, spatial included; `evaluate`'s `queryables` option; `duckdbFunctions.cql2_compare`, `sqliteFunctions.cql2_intersects_pair`; the standard's Table 16 on its test data; NaN ordered as PostgreSQL and DuckDB order it |
| 1.2.0 | **Arithmetic Expressions:** `+ - * / % div ^` wherever a number goes, in every part and engine; doubles, `div` toward zero and `%` its remainder, a non-finite result NULL; `sqliteFunctions.cql2_arithmetic`, PostgreSQL's `cql2_arithmetic` (in `postgresFunctions`); the standard's Table 17 on its test data |
| 1.3.0 | **Temporal Functions:** the fifteen relations of instants and intervals (OWL-Time, closed intervals, `'..'` open), in every part and engine; an instant refused where intervals only go; dates and timestamps never converted; the standard's 72 temporal rows on its test data. Fixed: infinite dates and timestamps NULL in every engine; DuckDB instants bound as text (node-api 1.4) |
| 1.4.0 | **The classes each engine supports:** `evaluateConformance` and `sqlConformance`, the lists `toEvaluator` and `toSql` refuse by, so a filter valid against them is never `unsupported`; the **developer guide** (`docs/guide/`) and a short README; demo-server and the playground use the lists. Fixed: `filterProperties` on INTERVAL ends; the `s_disjoint` documentation |
| 1.5.0 | **Oracle and SQL Server, for enterprise GIS:** the `oracle` dialect (every class, Oracle Spatial) and the `sqlserver` dialect (every class but Spatial Functions), on the dialect interface, tested live against each database (not in CI); `oracleFunctions` / `oracleValue`, `sqlserverFunctions` / `sqlserverValue`, `SqlColumn.spatialIndex`. Details below |
| later | more conformance classes (arrays); JSON-FG: `place`, `coordRefSys`, `filter-crs` and 3D comparison; an index-friendly SQL mode |

### 1.5.0: Oracle and SQL Server

Chosen for geospatial users: both are common under enterprise GIS (national mapping agencies, utilities, defence;
Esri enterprise geodatabases; Luciad / Fusion; GeoServer and QGIS support both). Each dialect meets the same rule as the
others: every generated filter selects exactly what `evaluate` selects, checked on the kitchen sink loaded into that
database, the spatial ones against GEOS on the US states. The rules each dialect documents are in its guide page.

| Question | Oracle | SQL Server |
|---|---|---|
| `''` | stored as NULL: comparisons with `''` decided at build time | a value, compared as it is |
| NFC | a documented rule (stored text in NFC); CASEI / ACCENTI normalize with the package's tables | the same |
| Text order | `COLLATE BINARY` on the parameter | UTF-8 bytes as varbinary (no blank padding) |
| Spatial | every relation, planar, tolerance 1e-10 (points within 1.4e-14° of a boundary may differ) | S_INTERSECTS only, through `STDistance` (points within rounding of a boundary may differ) |
| Index | a planar function-based index on `cql2_planar(column)` | the column's spatial index |
| Tested on | Oracle AI Database 26ai Free 23.26.3 | SQL Server 2022 and 2025 |

Testing without a server: both run locally in Docker, free for development and testing, spatial included. The
containers live outside the repository; the connections go in `demo-server/.env`; the tests skip, with the reason,
when a database isn't running.

| | Oracle | SQL Server |
|---|---|---|
| Edition | Oracle Database Free (23ai); the full image (the slim one has no Oracle Spatial) | SQL Server 2022 / 2025 Developer |
| Container | native arm64 and x86 (`gvenzl/oracle-free`, or Oracle's own image) | x86 only: on Apple Silicon, through Docker Desktop's Rosetta emulation |
| Memory | about 2 GB | at least 2 GB |
| Node driver (demo-server only) | `oracledb`, thin mode: plain JavaScript, no Oracle client | `mssql` (`tedious`): plain JavaScript |
| Loading the kitchen sink | `demo-server/data/load-oracle.ts` (GDAL's Oracle driver needs Oracle's client libraries) | `demo-server/data/load-sqlserver.ts` (GDAL's driver needs an ODBC driver) |
