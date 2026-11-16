# Research: CQL2's Array Functions

**Status: implemented in 1.6.0** (in every part and every engine), with the decisions proposed at the end, as taken.
The research dates from 2026-11-04, and the feasibility study from 2026-11-15. It records what CQL2 1.0.0 defines for arrays,
what it leaves open, what other implementations do (their code read, and run), and what each engine of the package
offers (measured). It ends with the questions a design has to answer, each with the option the measurements favour,
and a rough cost. Sources: CQL2 1.0.0 (OGC 21-065r2), its released grammar and JSON Schema (`cql2.bnf`, `cql2.json`,
tag `cql2-1.0.0` of github.com/opengeospatial/ogcapi-features), and OGC API - Features - Part 3: Filtering
(OGC 19-079r2) for the queryables.

## What the package did before 1.6.0

- `ogc-cql2/parse` already reads the whole `arrayPredicate` rule: `A_EQUALS`, `A_CONTAINS`, `A_CONTAINEDBY`,
  `A_OVERLAPS`, and array literals, `(` always opening an array in that position, even of one element or none.
- `ogc-cql2/text` doesn't write arrays yet, as expected while the class isn't implemented: `toText` refuses them
  through `validate` (`outside-profile`), and its writer has no array case. Only the parser reads them, because it
  covers the whole grammar.
- `ogc-cql2/validate` refuses an array predicate, and any array literal, as `outside-profile`, naming the class
  (`CQL2_CONFORMANCE.arrays`). `evaluate` and `toSql` never see one.
- A queryable of `type: "array"` can only be tested with `isNull`.

## What the standard requires

Requirements class **Array Functions** (`http://www.opengis.net/spec/cql2/1.0/conf/array-functions`), clause 7.9.
Its only dependency is Basic CQL2.

- **An array** "is a bracket-delimited, comma-separated list of array elements. An array element is either a scalar
  value, a geometry, an interval, or another array" (7.9.1). Example 20 shows `('a', 'c')`, `('a', true, 1)` and an
  array of three `DATE`s; in JSON, a JSON array: `["a", true, 1]`, `[{ "date": "1969-07-16" }, …]`.
- **The grammar** (`arrayPredicate = arrayFunction "(" arrayExpression "," arrayExpression ")"`):
  - an operand (`arrayExpression`) is an `array`, a `propertyName` or a `function`;
  - an element (`arrayElement`) is a character clause (a string, `CASEI(…)`, `ACCENTI(…)`), a number, a
    `temporalInstance` (a date, a timestamp, an interval), a `spatialInstance` (a geometry or a bbox), an `array`, an
    `arithmeticExpression`, a `booleanExpression`, a `propertyName` or a `function`;
  - `array = "(" ")" | "(" arrayElement { "," arrayElement } ")"`: the empty array is allowed.
  - The JSON Schema says the same (`array`: strings, numbers, any `cql2expression`, geometries, instants and
    intervals, arrays, property references).
- **Requirement 16** (`/req/array-functions/array-predicates`):
  - **A:** the `arrayPredicate` rule, except `function` as an operand or an element, and `arithmeticExpression` as an
    element (those come with the Functions and Arithmetic Expressions classes).
  - **B:** "Both array expressions SHALL be evaluated as **sets**. No inherent order SHALL be implied in an array of
    values."
  - **C:** `A_EQUALS` is TRUE "if both sets are identical", `A_CONTAINS` if the first set is a superset of the
    second, `A_CONTAINEDBY` if it is a subset, `A_OVERLAPS` if they "share at least one common element";
    **"otherwise the predicate SHALL evaluate to the Boolean value FALSE"**.
- **Permission 9:** a server may refuse an array as the first operand, and a property as the second. So without
  Property-Property Comparisons, the shape is `A_X(property, (literals))`. **Property-Property Comparisons withdraws
  Permission 9** (Requirement 17): then a literal array first, a property second, two properties, and two literals.
- **Requirement 29** (`/req/cql2-text/arrays`) and its JSON twin: read and evaluate every array expression in either
  encoding.
- **Queryables:** the test suite asks for "at least one queryable [that] has an array data type" (Part 3 describes
  queryables in JSON Schema: `{ "type": "array", "items": { "type": "string" } }`).
- **The conformance test** (A.11, Test 44) runs, for each array queryable, the four functions with `("foo","bar")`
  and asserts only that they execute; Test 45 combines the stored predicates with AND, OR and NOT. There is no test
  data with arrays in the standard's GeoPackage (Natural Earth), and no expected results.
- **The standard's examples** (`examples/`): `A_CONTAINS(layer:ids, ('layers-ca','layers-us'))` (clause 7.15 and
  example 21), `A_CONTAINEDBY("values", ('a', 'b', 'c'))` (79), `A_CONTAINS("values", ('a', 'b', 'c'))` (80),
  **`A_EQUALS(('a', TRUE, 1.0, 8), "values")`** (81: a literal first, so Property-Property, and mixed types),
  **`A_OVERLAPS("values", (TIMESTAMP('2012-08-10T05:30:00.000000Z'), DATE('2010-02-10'), FALSE))`** (82: mixed
  types).

## What the standard leaves open

1. **NULL.** Every other predicate has a NULL rule: "If either … is NULL then the predicate SHALL evaluate to the
   value NULL" (comparisons, LIKE, BETWEEN, IN, spatial, temporal, arithmetic). The array functions have none, and
   Requirement 16 C says "otherwise … FALSE". A property "SHALL evaluate to its corresponding value, or NULL if
   unset". So for a NULL or missing property, the literal reading gives FALSE, and consistency gives NULL. The two
   differ only under NOT: `NOT A_CONTAINS(tags, ('a'))` on a feature without tags is TRUE in the first reading, NULL
   (not selected) in the second.
2. **When two elements are "the same".** Sets are compared by their elements, and nothing says how elements are
   compared: whether `1` equals `1.0`, a date a timestamp, `'a'` `'A'`, `true` `1`. Permission 2 (type casts) lets a
   server refuse or cast incompatible types, "system dependent".
3. **NULL elements.** CQL2 has no NULL literal (grammar and schema), so a NULL element can only come from the data
   (`["a", null]` in a JSON property, a NULL in a PostgreSQL array). Nothing says whether it is a value of the set,
   an unknown, or nothing.
4. **Nested arrays.** "Both array expressions" are sets; whether an inner array is a set too (`('a','b')` the same
   as `('b','a')`) isn't said.
5. **Geometries and intervals as elements.** Identity of two geometries could be `S_EQUALS` (the same points) or the
   same coordinates; of two intervals, `T_EQUALS`. Not said.
6. **Properties, boolean expressions and `CASEI` / `ACCENTI` inside an array** are in the grammar, with no meaning
   given. A folded element can't meet a folded data element, as the property side can't be folded (an operand is a
   property, not `CASEI(property)`).
7. **A property holding something else than an array** (a string, an object): not said.
8. **The empty array** follows from the sets: the empty set is contained in every set (`A_CONTAINS(x, ())` TRUE),
   overlaps none (`A_OVERLAPS(x, ())` FALSE), and equals only itself. An empty array is not NULL.

## Other implementations

Run, 2026-11-04: cql2-rs as `cql2-wasm` 0.5.6 (npm, its newest there) and `cql2` 0.6.0 (PyPI), pygeofilter 0.4.0.

| | cql2-rs 0.5.6 (wasm) | cql2-rs 0.6.0 (Python) | pygeofilter 0.4.0 |
|---|---|---|---|
| In memory, `A_EQUALS` | sets (`('a','a','b')` equals `('b','a')`) | same | sets |
| NULL or missing property | **throws** ("Could not reduce expression to boolean") | same | **throws** (TypeError) |
| `1` and `1.0` | the same | same | the same |
| `true` and `1` | different | same | **the same** (Python's `True == 1`) |
| a string `"2010-02-10"` and `DATE('2010-02-10')` | different (no queryables to say the string is a date) | same | — |
| nested arrays | compared in order (`[['a','b']]` doesn't contain `('b','a')`) | same | throws (lists aren't hashable) |
| text `('a')` (one element) | read as the string `'a'`, then throws | **read as an array** | — |
| text `()` (empty) | read as a property named `A_OVERLAPS` | refused | — |
| JSON `a_containedBy` | yes | yes | **refused** (unknown operator) |
| SQL, `A_EQUALS` | **`v = ARRAY[…]`: ordered**, unlike its own evaluator | `v @> ARRAY[…] AND ARRAY[…] @> v`: sets | none (`NotImplementedError` for all four) |
| SQL, `A_OVERLAPS` | **`v @@ ARRAY[…]`**: no such operator in PostgreSQL (error) | same | none |
| SQL, others | `@>`, `<@` on a native array; DuckDB `list_has_all`, `list_has_any` | same | none |

Read in their code, at the commits in the research log (2026-11-04):

| Implementation | `A_EQUALS` | The other three | NULL / missing | Elements compared | Storage |
|---|---|---|---|---|---|
| cql2-rs (main, after 0.6.0), evaluator | sets | sets | left unreduced (throws in `matches`); a NULL element is the text `NULL`, so equal to another | **by their CQL2-text form**: `1` = `1.0`, `1` ≠ `'1'`, case-sensitive, `DATE(…)` ≠ a date string | JSON values |
| cql2-rs, SQL | `@>` both ways | `@>`, `<@`, **`@@`** (open issue developmentseed/cql2-rs#249) | the database's | the database's | native `ARRAY` / DuckDB `LIST` |
| pygeofilter (main) | Python sets | Python sets; **no SQL, Elasticsearch, OpenSearch, Django or SQLAlchemy backend** handles them | throws | Python's `==` (`True` = `1`); a string property is iterated as characters | — |
| pgstac | **`=` on `text[]`: ordered** | `@>`, `<@`, `&&`; its name `a_contained_by`, so the standard's `a_containedBy` is refused | NULL (STRICT functions) | **as text**: `1` = `'1'`, **`1` ≠ `1.0`**, `true` = `'true'` | `jsonb` turned into `text[]` |
| GeoTools / GeoServer | throws "not supported" | throws | — | — | GeoServer has the class but doesn't declare it |
| ldproxy (xtraplatform), a joined 1:n table | sets, by counting distinct values (repeated literals miscount) | semi-joins, `HAVING` | NULLs left out | SQL `=` per column type | a child table |
| ldproxy, a `jsonb` column | **`jsonb =`: ordered** | `@>`, `<@`; `A_OVERLAPS` refused | `jsonb`'s | `jsonb`'s (`1` = `1.0`) | `jsonb`; GeoPackage refuses array queryables |
| stac-server (OpenSearch) | none | `A_CONTAINS`, `A_OVERLAPS` only (`term`s) | — | the index's terms | a multi-valued field |
| cql2cpp | sets (`EXCEPT` both ways) | `A_OVERLAPS` unfinished; contains checks lengths first | `p NOT NULL` | SQLite `json_each` values | JSON text in SQLite |
| gocql2, cql2g4, ogc-cql2 (Rust crate), libCQL2 | ordered in three of four | `@>`, `<@`, `&&`; one overlaps only by position | — | — | native arrays |

- **Only ldproxy declares the class** (`…/conf/array-functions`, with its limits documented). GeoServer,
  stac-fastapi-pgstac, tipg (through cql2-rs's SQL), pygeoapi, stac-server and stac-fastapi-elasticsearch don't.
- **No two implementations agree.** `A_EQUALS` is ordered in pgstac, ldproxy's JSON columns, gocql2, the Rust
  `ogc-cql2` crate and libCQL2, against Requirement 16 B. Numbers are text in pgstac, so `1` ≠ `1.0`. `true` is `1`
  in pygeofilter. Each throws, skips or returns NULL for a missing property.
- **The conformance test itself** writes `A_CONTAINS({queryable},("foo","bar"))`: in CQL2-text, double quotes delimit
  **identifiers**, so `"foo"` and `"bar"` are property names, not strings (cql2-rs reads them so; measured).

### The standard's discussions (opengeospatial/ogcapi-features)

- **#384** (closed 2020-12), where the functions began: "start with set operators (subset, superset, overlaps,
  equal)", modelled on PostgreSQL's `@>`. Sets were the intent from the start.
- **#718** (closed 2023-02): arrays moved from `[…]` to `(…)`; the clash between a one-element array and a
  parenthesised expression was raised. **#972** (open, 2024-12): the same clash in the grammar; the working group
  (2025-05-19) would allow `[…]` beside `(…)` in a future version, and recommend `[…]`.
- **#676** (open, 2022-02): "any" / "all" matching between an array and a scalar, deferred. **#980** (closed 2025-08):
  arrays in comparisons and LIKE, answered "use functions". stac-api-extensions/filter **#36** (open, 2025-10): `=`
  on an array field differs between implementations; users are pointed to the `A_` functions.
- **No issue settles** NULL, element identity, NULL elements, nested arrays or mixed types.

## Engines, measured

Measured 2026-11-04: PostgreSQL 13.5 and 18.1 (identical), DuckDB 2.0.0 and 1.4.3 (DuckDB-WASM's engine;
identical), SQLite 3.51.3 (`node:sqlite`, Node 24), GDAL 3.8.5, Oracle AI Database 26ai Free 23.26.3, SQL Server
2022 (16.0.4305) and 2025 (17.0.5035) (identical but for the `json` type). The browser itself (DuckDB-WASM in
Chrome) was not measured.

### How the data holds an array

| Store | Holds an array as | Typed elements? |
|---|---|---|
| GeoJSON (`evaluate`) | a JSON array | no: strings stand for dates and timestamps; only the queryables say which |
| PostgreSQL | a native array (`text[]`, `float8[]`, `date[]`, …), or `jsonb` | native: one type; `jsonb`: mixed, dates as strings |
| DuckDB, GeoParquet | a native `LIST` (`VARCHAR[]`, …) | one type |
| SQLite, GeoPackage | JSON text. **GDAL writes list fields (`StringList`, `IntegerList`, `RealList`) to GeoPackage as JSON text**, declared `application/json` in `gpkg_data_columns` | mixed |
| Oracle | JSON (the `JSON` type, or text `IS JSON`); no array type for columns in practice | mixed |
| SQL Server | JSON text (`nvarchar`); the `json` type from 2025 | mixed |

### PostgreSQL (native arrays and `jsonb`)

| Probe | Result |
|---|---|
| `ARRAY['a','b'] @> ARRAY['b','a','a']` | TRUE: `@>`, `<@`, `&&` are set operators (order and repeats ignored) |
| `ARRAY['a','b'] = ARRAY['b','a']` | **FALSE: `=` is ordered**. Set equality is `a @> b AND a <@ b` |
| `ARRAY['a'] @> '{}'`, `'{}' && '{}'` | TRUE, FALSE: the empty set as the standard's sets |
| `NULL::text[] @> …` | NULL |
| `ARRAY['a',NULL] @> ARRAY['a']` / `ARRAY['a',NULL] <@ ARRAY['a','b']` / `… @> ARRAY[NULL]` | TRUE / **FALSE** / FALSE: a NULL element equals nothing, so it blocks "contained by" |
| `int[] @> float8[]`, `text[] @> int[]`, `date[] @> timestamptz[]`, **`varchar[] @> text[]`** | errors: both sides must have the same element type, **even `varchar[]` and `text[]`**, so the literal has to be cast to the column's own type |
| `ARRAY['A'] @> ARRAY['a']`, `ARRAY['a '] @> ARRAY['a']` | FALSE, FALSE: exact text, no padding |
| `ARRAY[[1,2],[3,4]] @> ARRAY[2,3]` | TRUE: a multi-dimensional array is flattened, so **native arrays can't hold nested arrays** |
| `NaN` / `-0` elements | `NaN` equals `NaN`, `-0` equals `0` (array element comparison uses the type's total order) |
| `jsonb`: `'["a","b"]' @> '["b","a","a"]'` | TRUE |
| `jsonb`: `1` and `1.0`; `true` and `1`; `"1"` and `1` | the same; different; different |
| **`jsonb`: `'["a"]' @> '"a"'`** | TRUE: a scalar on the right is taken as an array of one |
| **`jsonb`: `'[["a","b"],"c"]' @> '[["b"]]'`** | TRUE: containment is recursive, so a nested array "contains" a part of itself |
| `jsonb`: `'["a",null]' @> '[null]'` | TRUE: JSON null is a value |
| `jsonb`: overlap | no operator; `?|` works for strings only; otherwise `EXISTS` over `jsonb_array_elements` |
| Indexes (200,000 rows) | a GIN index serves `@>`, `<@`, `&&` on a native array, and `@>` on `jsonb` (`jsonb_path_ops`) |

### DuckDB (`LIST`)

| Probe | Result |
|---|---|
| `list_has_all(['a','b'], ['b','a','a'])`, `list_has_any`; operators `@>`, `<@`, `&&` | sets, as PostgreSQL's |
| `['a','b'] = ['b','a']` | FALSE: ordered |
| empty lists | as the standard's sets |
| `NULL` list | NULL |
| **NULL elements** | **ignored in the second list**: `list_has_all(['a','b'], ['a',NULL])` TRUE, `list_has_all(['a',NULL], [NULL])` TRUE, `list_has_any(['a',NULL], [NULL])` FALSE. So DuckDB and PostgreSQL disagree |
| `[1,2]::INT[]` and `[1.0]::DOUBLE[]` | cast, the same |
| **`[true]` and `[1]`; a `DATE` and a `TIMESTAMPTZ`** | **cast, the same**: DuckDB casts silently where PostgreSQL refuses, so the literal's type has to be the column's |
| `['1']` and `[1]` | error (no common type) |
| nested lists | compared in order |
| JSON: `'1'::JSON = '1.0'::JSON` | FALSE: JSON is compared as text; a JSON array is turned into a `LIST` with `from_json` first |

### SQLite and GeoPackage (JSON text, `json_each`)

| Probe | Result |
|---|---|
| `json_each('["a",true,1,1.0,null,["x"],{"k":1},1e400,-0.0]')` | `value` is `a`, **1**, 1, 1.0, NULL, `["x"]`, `{"k":1}`, **NULL**, 0; `type` is `text`, `true`, `integer`, `real`, `null`, `array`, `object`, `real`, `real` |
| `true` and `1` by `value` | **the same**: `type` has to be compared too |
| `1` and `1.0`; `"1"` and `1`; `"A"` and `"a"` | the same; different; different |
| `1e400` | its `value` is NULL (out of range for a double) |
| `json_each(NULL)` | no rows |
| **`json_each('"a"')`** (a scalar) | **one row**: a property that isn't an array looks like an array of one, unless `json_type(…) = 'array'` is checked |
| **malformed JSON** | **the whole query fails** ("malformed JSON"); `json_valid` tells it first |
| nested arrays | `value` is the inner array as minified JSON text, so compared in order |
| JSONB blobs (3.45+) | `json_each` reads them too |
| a set operation | `NOT EXISTS (SELECT 1 FROM json_each(:lit) b WHERE NOT EXISTS (SELECT 1 FROM json_each(col) a WHERE …))` for "contains"; no index |

### Oracle (JSON)

| Probe | Result |
|---|---|
| `JSON_TABLE(…, '$[*]' COLUMNS (v VARCHAR2 PATH '$', t PATH '$.type()'))` | `type()` gives `string`, `number`, `boolean`, `null`, `array`, `object` |
| **`""` in a JSON array** | **read into a `VARCHAR2` column, it becomes NULL** (Oracle's `''` is NULL), though the JSON holds it; read with `FORMAT JSON` it stays `""` |
| `1.0` | read as text, `1` (normalized); as a number, equal to `1` |
| JSON NULL / a scalar / malformed JSON | no rows / **no rows** / error (ORA-40441) |
| `JSON_EXISTS(col, '$[*]?(@ == $x)' PASSING :b AS "x")` | works, with binds |
| **`JSON_EXISTS` comparisons are loose:** `["1"]` matches `1`, `[true]` matches `"true"`; `1.0` matches `1` | a `@.type() == "string" && @ == "1"` guard makes them exact (measured) |
| a string literal over 4,000 bytes | error (ORA-01704): literals are bound |

### SQL Server (JSON, `OPENJSON`)

| Probe | Result |
|---|---|
| `OPENJSON('[…]')` | `value` is always text (`true`, `1`, `1.0`, `["x", "y"]` as written), `type` 0–5 (null, string, number, boolean, array, object) |
| `1` and `1.0` by `value` | different: numbers have to be cast (`CAST(value AS float)`) |
| `1e400` | text `1e400`; a cast to `float` fails |
| **`"a "` and `"a"`; `"A"` and `"a"`** | **the same** under the server's default collation (padding, and case-insensitive collation): the dialect's existing padding-safe, binary comparison is needed |
| nested arrays | raw text, **with the data's whitespace**: `["x", "y"]` and `["x","y"]` differ |
| JSON NULL / a scalar / malformed JSON | no rows / **error** / **error**: the whole query fails, unless guarded by `ISJSON` and the type |
| the `json` type | 2025 only |

## What it means for a design

These are the questions a design has to settle, each with the option the measurements favour; nothing is decided.

1. **Set semantics** (Requirement 16 B). Every engine has set operators or can build them, but **`=` on arrays is
   ordered in PostgreSQL and DuckDB**: `A_EQUALS` has to be "contains and is contained by", as cql2-rs 0.6.0 now
   writes it.
2. **NULL.** Favoured: **NULL when an operand is NULL or missing**, as every other predicate of the standard and as
   the package's three-valued `evaluate` does elsewhere, and pgstac does; the literal "otherwise FALSE" reading would
   make `NOT A_CONTAINS(tags, …)` select features without tags. Either is cheap in every engine (NULL in, NULL out
   natively; a `CASE` for JSON). No issue of the standard raises it; worth raising.
3. **The profile of elements.** Favoured: **strings, numbers, booleans, dates and timestamps**, the scalars every
   engine can compare exactly; geometries, intervals, nested arrays, properties, functions, arithmetic, boolean
   expressions and `CASEI` / `ACCENTI` inside an array refused as `outside-profile`, as with the other classes.
   Nested arrays are measured unsafe in two engines (PostgreSQL flattens, `jsonb` contains recursively, SQL Server
   compares raw text).
4. **Element identity: the package's `=`.** Two elements are the same when `=` between them would be TRUE: numbers by
   value (`1` = `1.0`), strings by code point (no padding, no case), booleans only with booleans, dates with dates,
   timestamps with timestamps (never converted, as Temporal does). This rules out each engine's own casts: DuckDB's
   `true` = `1` and date = timestamp, SQLite's `true` = `1`, Oracle's loose JSON path, SQL Server's collation and
   padding.
5. **Typing through the queryables.** An array queryable's `items` (`type`, `format: "date"` / `"date-time"`) says
   what the elements are, as a queryable does for a scalar today; a literal element of another kind is a
   `type-mismatch` (Permission 2). Without `items`, `evaluate` can still compare by the literal's kind, but SQL needs
   the column's element type (a native array must be compared with a literal of its own type, `varchar[]` included).
   The standard's own mixed examples (81, 82) then work against an untyped queryable, and fail against a typed one.
6. **NULL elements** (only from data). Two exact options:
   - **ignored** (a set holds values; NULL is none): PostgreSQL `array_remove(col, NULL)`, DuckDB
     `list_filter(…, x -> x IS NOT NULL)`, JSON `type <> 'null'`;
   - **unknown** (SQL's reading): any NULL element that could decide the answer makes the predicate NULL. Harder to
     write exactly in five dialects.
   PostgreSQL and DuckDB disagree today (above), so either needs the dialect to decide it, not the engine.
7. **Not an array, or malformed JSON** (JSON stores): favoured NULL, as a value the predicate can't use. Needed in
   all three JSON engines, where a scalar silently becomes an array of one (SQLite) or none (Oracle), or the query
   fails (SQL Server, and malformed JSON in all three): `json_valid` / `IS JSON` / `ISJSON` and the type, first.
8. **How a column says it holds an array.** `SqlColumn` already has `type`, `format` and `sqlType`: a native array
   (PostgreSQL `text[]`…, DuckDB `LIST`) or JSON (SQLite / GeoPackage text, PostgreSQL `jsonb`, Oracle, SQL Server).
   GeoPackage's `gpkg_data_columns` `application/json`, as GDAL writes it, can say the second.
9. **Operands.** Permission 9's shape (`A_X(property, (literals))`) under Array Functions alone; with
   Property-Property, a literal first (example 81), two array properties, and two literals (decided when the SQL is
   built, as for the other classes).
10. **Indexes.** Only PostgreSQL's GIN index helps, for `@>`, `<@`, `&&` on native arrays and `@>` on `jsonb`; the
    exact shape (point 4, point 6) has to keep the bare operator in the `WHERE` so the planner can use it, with the
    exact test beside it.
11. **Proof.** The same as for the other classes: differential tests of every engine against `evaluate`, with data
    holding repeats, the empty array, NULL, NULL elements, `1` / `1.0`, `true` / `1`, `"1"` / `1`, `""`, `"a "`,
    `"A"`, dates and timestamps alike, scalars and malformed JSON where the store can hold them; the standard's five
    array examples; Test 44 and 45's shapes (with strings: as written, Test 44 compares properties). Test data with
    arrays has to be made (the standard has none).
12. **CQL2-text's one-element array.** The package already reads `(…)` after an `A_` function as an array, even of
    one (`('a')`) or none (`()`), as the grammar says; cql2-rs 0.5.6 didn't, 0.6.0 does for scalars, and refuses `()`.
    The `[…]` the working group proposes (#972) isn't in 1.0, so not read.

## Cost

About the size of Temporal Functions (1.3.0): the parser and the text writer exist, `validate` and `evaluate` are
small (a few dozen lines for the four operators); the work is in the dialects, each with its own storage and traps
(above), and in the test data. Phases, as before: (1) the decisions above; (2) `validate`, `evaluate`, the standard's
examples; (3) PostgreSQL (native and `jsonb`) and DuckDB; (4) SQLite / GeoPackage, Oracle, SQL Server; (5) the
guides, demo-server and the playground.

## Feasibility study (2026-11-15)

**Verdict: feasible, and backwards compatible.** Every change is one that the stability policy (README, "Versioning
and stability") lets a minor version make. Existing filters keep their SQL, text and answers. The work is
**larger than this document's cost section says**: about twice Temporal Functions, and less than Oracle + SQL Server
(see Effort below).

### Review of this document

Checked on 2026-11-15 against the standard (the HTML of 21-065r2) and against the package (`dist`, built from
1.5.0):

- **The standard is quoted correctly:**
  - Requirement 16 A–C (sets, and "otherwise … FALSE");
  - Permission 9 A/B, and its withdrawal by Property-Property Comparisons (`/req/property-property/withdraw-permissions`);
  - Test 44's `("foo","bar")`, which are identifiers in CQL2-text.
- **The package, as described.** `fromText` reads `A_CONTAINS(tags, ('a'))`, `A_OVERLAPS(tags, ())` and example
  81, and `validate` then refuses each one as `outside-profile`, naming `CQL2_CONFORMANCE.arrays`. Nothing past the
  parser handles arrays yet, the text writer included, so writing them is a small part of the work.
- **NULL (question 2): the preferred reading has the standard's support.** Clause 7's introduction says a predicate
  "evaluates to the Boolean values of TRUE or FALSE or that evaluates to the value NULL when dealing with unknown
  values". Requirement 2 B says an unset property "SHALL evaluate to … NULL". Read together, NULL for an unknown
  operand is a reading of the standard, not a departure from it. Requirement 16 C's "otherwise FALSE" is still the
  literal text, so the choice should be documented, and the question is still worth raising with OGC.
- **Sound as it stands:**
  - the set semantics, and `A_EQUALS` written as "contains and is contained by" (question 1);
  - the scalar-only element profile (3);
  - element identity by the package's own `=` (4);
  - typing through `items` (5).

  Each matches a rule the package already applies to the other classes.
- **Gaps:**
  - **The customer's stores aren't known.** Which engines and storage forms they need decides the order of the
    phases, and whether the first release can stop at PostgreSQL and DuckDB.
  - **Not measured yet:**
    - DuckDB-WASM in the browser, as the engines section says;
    - Linux arm64, for any engine;
    - the exact SQL shapes, rather than the engines' own operators;
    - whether PostgreSQL's GIN index survives the exact guard (question 10).
  - **The backwards-compatibility analysis and the per-dialect gating** are missing (both below).

### Backwards compatibility

| Change | Allowed by the stability policy as | Notes |
|---|---|---|
| New `Cql2Filter` members (`ArrayPredicate`, the array literal) | "filter shapes … as a class is implemented" | Code that reads filters keeps a default case, as the policy asks |
| `Queryable.items` (optional) | "options … only gain optional keys" | `items` is ignored today ("other keys … are ignored"), so a queryables response that already has it now gets used, but only by array filters, which were refused before |
| A new `CONFORMANCE.arrays` key (`CQL2_CONFORMANCE.arrays` exists already) | "new keys in `CONFORMANCE`" | |
| `SqlColumn`: how a column holds an array (native or JSON) and its element type | "keys in `SqlColumn`" | **Prefer new optional keys to widening `type`'s union** (`"string" \| "number" \| "integer" \| "boolean"`): new keys are additive beyond doubt; a wider `type` would break code that switches over it exhaustively |
| `validate`'s default `conformance` now accepts array filters, and `fromText` / `toText` with it | documented: "accepts a newly implemented class after an upgrade" | As for 1.1.0–1.3.0. A server passes the classes it declares |
| `evaluateConformance` / `sqlConformance` lists grow | "The lists grow as classes are implemented" (1.4.0) | **Trap:** `sqlConformance` returns `implementedBut([])` for a dialect with `relate` (Oracle, PostgreSQL, DuckDB, SQLite with SpatiaLite), so implementing the class would at once claim it for **every** such dialect. Each dialect without array SQL must exclude it explicitly until it has it |
| Possible new `ProblemCode`s (an element type outside the profile, say) | "new codes" | Prefer the existing `outside-profile` and `type-mismatch` |
| `isNull` on an array queryable | unchanged | |

**Proof that nothing else changed:** the 1.4.0 routine. Compare 1.5.0 and the new version on the shared corpus
(every output, refusals included) and expect no differences outside array filters.

### Effort

Measured on the earlier releases (lines added, `src` and tests, from their commits):

| Release | Dialects touched | Lines (all / `src` / tests) |
|---|---|---|
| 1.2.0 Arithmetic | 3 | 807 / 328 / 382 |
| 1.3.0 Temporal | 3 | 1,237 / 488 / 599 |
| 1.5.0 Oracle + SQL Server | 2 new | 4,904 / 1,407 / 1,416 |

Arrays touch **five dialects and seven storage forms**:
- PostgreSQL: native arrays, and `jsonb`;
- DuckDB: `LIST`, in Node and in DuckDB-WASM;
- SQLite / GeoPackage: JSON text;
- Oracle: JSON;
- SQL Server: JSON text in `nvarchar`, and the `json` type in 2025.

Each has its own traps (the engines section). Each also needs array test data in demo-server's stores, which have
none today, and the standard has none either. **Estimate: about 2,500–3,500 lines, in six phases**:

| Part | Share |
|---|---|
| `validate`, `evaluate`, the types, the `toText` writer | small (about 10%) |
| PostgreSQL native + `jsonb`, DuckDB Node + WASM | about 30% |
| SQLite / GeoPackage, Oracle, SQL Server (JSON guards, exact typing) | about 35% |
| Test data in six stores, the differential tests, the guides, the playground | about 25% |

### Phases

The first step is research on the standard itself, then a few spikes, and only then the design.

1. **Research the standard.**
   - Re-read 7.9 and every class it combines with: Basic CQL2's NULL rules, Property-Property, Arithmetic,
     Functions, and the CQL2-text and CQL2-JSON requirements.
   - Read the released grammar and schema against the current development branch of ogcapi-features, for changes
     since 1.0.0 (#972's `[…]` arrays).
   - Search the issue trackers for anything after 2025-10 on NULL, element identity, NULL elements and nested arrays.
   - Outcome: each open question (1–12 above) answered with the standard's text, or marked as the package's own
     reading. Whether to raise the NULL and identity questions with OGC is the owner's call.
2. **Spikes** (throw-away, in the session scratchpad):
   - (a) the exact SQL for the preferred decisions in each storage form, run against a small `evaluate` prototype
     on edge-case data: repeats, `()`, NULL, NULL elements, `1` / `1.0`, `true` / `1`, `"1"` / `1`, `""`, `"a "`,
     `"A"`, a date and a timestamp, a scalar, malformed JSON;
   - (b) PostgreSQL's GIN index with the exact guard beside the bare operator, on 13 and 18, amd64 and arm64;
   - (c) DuckDB-WASM in headless Chrome;
   - (d) what the guards cost on the JSON stores (`json_valid` / `IS JSON` / `ISJSON`, and the type checks);
   - (e) GDAL's GeoPackage list fields (`StringList` …) read back as JSON text.
3. **The core:** the decisions approved; `validate`, `evaluate`, `toText`, the types, and the standard's five
   examples.
4. **PostgreSQL (native and `jsonb`) and DuckDB (Node and WASM).**
5. **SQLite / GeoPackage, Oracle, SQL Server.**
6. **demo-server, the playground, the guides; CHANGELOG and version.**

**Optional split, also backwards compatible:** release phases 1–4 as one minor version, with SQLite, Oracle and SQL
Server leaving the class out of `sqlConformance` (as SQL Server leaves out Spatial Functions today), and phase 5 as
the next. (Not taken: 1.6.0 has every engine.)

### Risks

- **The next CQL2 version may change arrays** (#972, `[…]` beside `(…)`). That would be an addition on top of this
  work, not a break.
- **No index on the JSON stores:** `json_each` / `JSON_TABLE` / `OPENJSON` scan every row. Only PostgreSQL's GIN
  index helps. Document it per dialect.
- **Engines disagree on NULL elements and on casts** (PostgreSQL against DuckDB; SQLite's `true` = `1`; Oracle's
  loose path comparisons; SQL Server's collation). Each dialect has to decide these itself, which is where most of
  the work and the risk lie.
- **No conformance data to check against:** Test 44 only checks that the filters execute. The proof rests on
  `evaluate` and on test data made for this.

### Questions before planning

1. Which stores does the customer use (PostgreSQL native arrays, `jsonb`, GeoParquet / DuckDB, GeoPackage, Oracle,
   SQL Server, in memory)?
2. Which element types do they need (strings only, or numbers, booleans, dates, timestamps too)?
3. For a NULL or missing array: NULL, which is preferred and backed by clause 7, or the literal "otherwise FALSE"?
4. One release, or the split above?

## Decisions proposed (Phase 1, 2026-11-15)

**Status:** taken, and implemented in 1.6.0 (how, in [architecture.md](architecture.md)). The evidence is in `research/arrays/README.md`
("Phase 1"):
- the standard read again (21-065r2, the 1.0.1 draft, Part 3);
- the trackers since 2025-10;
- an `evaluate` prototype, and every engine compared with it answer by answer: DuckDB 2.0 / 1.4 / WASM,
  PostgreSQL 13 / 18 on amd64 and arm64, SQLite, Oracle 23.26, SQL Server 2022 / 2025.

Every shape below gave **0 differences** from the prototype.

### What the research added

- **NULL has the standard's support.** Every other predicate requirement has "otherwise … FALSE" and then "if
  either … is NULL … NULL": comparisons, LIKE, BETWEEN, spatial, temporal, CASEI / ACCENTI, arithmetic. Requirement
  16 has the first and lacks the second, so the gap reads as an omission. Clause 7 says a predicate "evaluates to
  the value NULL when dealing with unknown values". The 1.0.1 draft only renames grammar rules, and adds no NULL
  rule.
- **Part 3, Recommendation 1 I:** array queryables "SHOULD consist of items that are strings or numbers". Its
  example declares `{"type": "array", "items": {"type": "string"}}`.
- **A new issue, ogcapi-features #1099** (2026-11-06, open): CartoSym asks a future revision for ordered array
  functions beside 1.0's sets. Nothing changes for 1.0.
- **Traps the dialects must handle,** all measured:
  - DuckDB 2.0 refuses `x -> …` lambdas (`lambda x: …` works in 2.0, 1.4 and WASM);
  - in every JSON shape, a match that can be NULL makes `NOT EXISTS` keep a row wrongly (`TRY_CAST` of `1e400`,
    Oracle's `""`), so every match must be FALSE, never NULL;
  - **Oracle answers `A OR B` over `JSON_TABLE` columns wrongly** where `B OR A` is right; a `CASE` around each
    condition avoids it;
  - a `jsonb` number beyond a double fails the query unless guarded;
  - `ISJSON(v, ARRAY)` needs SQL Server 2022, which is the dialect's minimum already.

### The decisions

| # | Question | Proposed | Evidence |
|---|---|---|---|
| 1 | Set semantics | Sets; `A_EQUALS` = contains and is contained by (never `=` on arrays) | Requirement 16 B; `=` is ordered in PostgreSQL and DuckDB; exact everywhere as sets |
| 2 | A NULL or missing array | **NULL**, documented as the package's reading of the standard; raising it with OGC is the owner's call | The pattern of every other predicate, and clause 7 (above) |
| 3 | Elements in the profile | **Strings, numbers, booleans, dates, timestamps.** Geometries, intervals, nested arrays, properties, functions, arithmetic, boolean expressions and `CASEI` / `ACCENTI` inside an array are refused as `outside-profile` | Part 3 Rec. 1 I; scalars measured exact in every engine; nested arrays unsafe in three |
| 4 | When two elements are the same | **The package's `=`**: a data element is read as the literal element's kind and never cast. So `1` = `1.0`, `true` ≠ `1`, `"1"` ≠ `1`; text exact after NFC, no padding or case; a date string equals a `DATE`, instants to the millisecond | Requirement 3 D and IN's B ("the same literal type"); type casts are system dependent; 0 differences in every engine |
| 5 | Typing through the queryables | An array queryable's `items` (`type`, `format`) types the elements: a literal element of another kind is `type-mismatch`, as for a scalar property. Without `items`, each literal element brings its own kind, so the standard's mixed examples 81 / 82 work | The package's scalar rule; Part 3's `items`. In SQL, the column says the element type, and a literal element that can't match is decided when the SQL is built |
| 6 | NULL elements (only from data) | **Ignored**: a set holds values, so `["a", null]` is `{"a"}` and `[null]` is `{}`. The other option, **unknown** (SQL's three-valued reading, NULL wherever a NULL element could decide), is also exact in DuckDB and PostgreSQL, but needs a `CASE` per function and more SQL in the JSON stores | Both readings measured; "ignored" is DuckDB's own behaviour (it ignores NULLs in the second list) and the simplest everywhere; the standard is silent |
| 7 | A value that isn't an array (a scalar, an object, malformed JSON) | **NULL** | Exact and cheap guards in every JSON store: `json_valid` + `json_type`, `IS JSON` + `$.type()`, `ISJSON(v, ARRAY)`, `jsonb_typeof` |
| 8 | How a column says it holds an array | New optional keys only, never a wider `SqlColumn.type`: an `items` like the queryable's (element `type`, `format`). The storage (native or JSON) is read from `sqlType` (`text[]`, `VARCHAR[]`, `jsonb`, `JSON`…). The exact keys are settled in each dialect's plan | Backwards compatibility; GDAL declares GeoPackage list fields `application/json` |
| 9 | Operands | Without Property-Property, Permission 9's shape `A_X(property, (literals))`. With it: a literal first, two array properties, and two literals (decided when the SQL is built), as in the other classes | Requirement 17 withdraws Permission 9. Two JSON properties weren't measured (nested `EXISTS`): a Phase 3–7 check |
| 10 | Indexes | **PostgreSQL:** the dialect writes an IMMUTABLE function of the exact view (`cql2_text_array(v)` and the like, from `postgresFunctions`), and a user who wants the index creates a GIN index on that expression, as for Oracle's `cql2_planar`. **Elsewhere:** none (DuckDB lists, JSON stores); documented | 0.65 ms against 333 ms on 200,000 rows (18 arm64). `date_trunc` on `timestamptz` is only STABLE, so that view needs another expression |
| 11 | SQLite / GeoPackage | **A registered function `cql2_array(op, value, literal)`** running `evaluate`'s own code, as `cql2_intersects` does | Exact, as fast as a `json_each` shape (242 against 248 ms on 200,000 rows), and much less SQL |
| 12 | CQL2-text | Keep reading `(…)` after an `A_` function as an array, even `('a')` and `()`. `[…]` stays refused (not in 1.0, though Part 3's own examples write it) | The grammar; #972 is for a future version |
| 13 | Proof | As for the other classes, plus: array test data in every demo-server store (the standard has none); the standard's five examples; Tests 44 / 45 with string literals; a mutation per rule | |

### What changes in the phases

Nothing in their order. Phase 2 (the core) can start once decisions 2–8 are made. The traps above go into each
dialect's plan, and decisions 10 and 11 shape Phases 3 and 5.

### How servers serve arrays from PostgreSQL (added 2026-11-15)

Measured on GeoServer 3.0.2, ldproxy 4.8.2 and pygeoapi, all against one table with every array type
(`research/arrays/README.md`, 1c). It matters to the design because it shows what clients actually receive, and so
what `evaluate` will be given.

| | GeoServer 3.0.2 (WFS) | ldproxy 4.8.2 (OGC API) | pygeoapi (OGC API) |
|---|---|---|---|
| Native arrays (`varchar[]`, `float8[]` …) in GeoJSON | **lost**: Java's `toString()`, `"[Ljava.lang.String;@…"`; `text[]` / `numeric[]` dropped from the layer | not supported (text of the array in one element) | **JSON arrays**, types kept |
| `jsonb` arrays in GeoJSON | a JSON **string** holding the text | JSON arrays from a document column (`[JSON]col/key`), elements converted to the declared type; objects or nested arrays inside fail the request | JSON arrays as stored |
| NULL elements | — | dropped | kept as `null` |
| Empty array | — | left out (like NULL) | `[]` |
| GML | the same `toString()`, each array one `xsd:string` | — | — |
| Writing (WFS-T) | the whole text becomes one element; a `text[]` column makes the layer read-only | — | — |
| Queryables | — | `{"type": "array", "items": {…}}` (Part 3) | `"string"` |
| Array filters | "any element" for `=` / `IN` (`&&`, `unnest`); no CQL2 array functions | the four, but `A_EQUALS` ordered, a NULL element blocks `A_CONTAINEDBY`, `A_OVERLAPS` hangs | none (`Bad CQL text`) |

**What it means for the decisions:**
- **Decision 4 (identity):** what `evaluate` gets is JSON arrays of strings, numbers, booleans and `null` (pygeoapi,
  ldproxy). Dates come as strings and timestamps in several forms (`+00:00`, microseconds). The package's readers
  already accept those forms. Nothing changes.
- **Decision 6 (NULL elements):** servers disagree. ldproxy drops them before the client sees them, so "ignored" is
  what an ldproxy client's `evaluate` would compute anyway. pygeoapi keeps them. "Ignored" stays the proposal.
- **Decision 5 (typing):** ldproxy's queryables carry `items` exactly as Part 3 has them, which is what decision 5
  reads. pygeoapi's are wrong (`"string"`), so an untyped fallback is needed.
- **Decision 8 (SQL columns):** no server is a model for storage. GeoServer can't serve arrays at all. ldproxy only
  supports JSON document columns, and pygeoapi doesn't filter them. PostgreSQL native arrays and `jsonb` stay the
  two forms to support.
- **For the guide:** an empty array and NULL must stay apart. ldproxy merges them, and the standard's sets don't
  (`A_CONTAINS(x, ())` is TRUE for `[]` and NULL for NULL).
