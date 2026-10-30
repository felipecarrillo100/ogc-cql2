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

Three conformance classes, implemented completely: Basic CQL2, Advanced Comparison Operators and Case-insensitive
Comparison. Within them, the profile accepts the form every server must support: the standard lets a server accept
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
| `ogc-cql2/sql` | `src/sql/` | `toSql`, `sqliteFunctions`: CQL2-JSON → a parameterized `WHERE` clause | 0.1.0: `sqlite`; `postgres` later |
| `ogc-cql2/parse` | `src/parse/` | CQL2-text → CQL2-JSON, for a server that receives text | later, if needed |

`text` and `evaluate` validate their input first, so they load `validate` too.

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
    an offset, or a `Date`, to the millisecond. A time without an offset is ambiguous, so *unknown*;
  - strings are compared after NFC normalization (the standard's Recommendation 1), in code point order;
  - a `LIKE` `_` matches one code point.
- **`CASEI`** applies Unicode's full case folding (CaseFolding 15.0.0, statuses C and F), as the standard requires.
  JavaScript has none built in, so `scripts/gen-case-folding.mjs` generates a compact table
  (`src/evaluate/caseFolding.ts`, about 1.5 kB gzipped). It folds exactly what it wraps.
- **Features** are read as GeoJSON, `feature.properties[name]`; `getProperty` replaces that for other shapes.
- **Compiled once:** `toPredicate` and `toEvaluator` validate the filter and prepare its patterns and literals, so
  each feature costs only the comparisons.

### SQL (`ogc-cql2/sql`)

`toSql(filter, { dialect, columns })` returns `{ where, params }`: text and values only, no driver. The rule: the SQL
selects exactly the rows `evaluate` selects from the same values.

- **Always parameterized:** values are `?` placeholders, never text inside the query.
- **Property names are checked** against `columns` (the table's queryables), then quoted; anything else is
  `unknown-property`. A property can map to a column of another name.
- **CQL2's three-valued logic maps directly** onto SQL's NULL (`AND`, `OR`, `NOT`).
- **The pattern others use:** a field mapping and a function map, as pygeofilter's SQL backend does; unlike it, values
  are never put into the SQL text.

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
| `{date}` | `cql2_day(c)`: a `YYYY-MM-DD` value |
| `{timestamp}` | `cql2_instant(c)`: an ISO 8601 date-time with `Z` or an offset, in milliseconds |
| `like` | `cql2_like(view, pattern)`: case-sensitive, `%` `_` `\` |

The `cql2_*` functions are `sqliteFunctions`, which the application registers on its connection. They run the same
code as `evaluate` (`src/evaluate/strings.ts`). SQLite's own LIKE ignores ASCII case (its `case_sensitive_like`
pragma is deprecated) and its `lower()` folds ASCII only, so neither can be used.

**The cost of exactness:** the typed views and functions stop SQLite from using an index for those predicates. An
index-friendly mode, for tables whose values are known to match their declared types, can come later, measured
against the same tests.

### Errors

- **Every refusal throws a `Cql2Error`:** `invalid-filter` (from `assertValid`, and from `text` and `evaluate` for an
  invalid input) or `not-expressible` (from `toText`), with a message, the path inside the filter and `details`.
- **Callers test the `code`, not `instanceof`.** That keeps working even when two copies of the package end up in one
  application.

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
  - and, if it must accept CQL2-text, parses it (`ogc-cql2/parse`, later).

## The demo server (`demo-server/`, not published)

A Node backend (Express 5) that answers the playground's filters from data files, through a **store layer**: one
store per collection, each answering the same three questions (describe yourself, your queryables, the features a
filter selects). The server never knows which store it talks to.

| Store | Reads | Filters with | Status |
|---|---|---|---|
| GeoJSON | one FeatureCollection file, read once at startup | `ogc-cql2/evaluate` | 0.1.0 |
| GeoPackage (SQLite) | the `features` and `attributes` tables a GeoPackage lists in `gpkg_contents` (Node's built-in `node:sqlite`, read-only) | `ogc-cql2/sql` | 0.1.0 |
| PostgreSQL / PostGIS | tables of a database; the connection in a git-ignored `.env` | `ogc-cql2/sql` | later |

- A GeoPackage table: the id is its INTEGER primary key (Req 29, 119), the queryables come from its declared types
  (Table 1), BOOLEAN 0 / 1 is served as `false` / `true`, and geometry is decoded from GeoPackageBinary (the `GP`
  header, then WKB) to GeoJSON. A table not in WGS 84 is served without geometry, and that's reported.
- Every store answers GeoJSON features. A GeoJSON file's ids are kept when unique; missing ones are generated
  deterministically (the position in the file, or after the largest numeric id); a duplicate id drops the later
  feature, which is reported.
- The server validates each filter (`validate`), checks its properties against the collection's queryables
  (`filterProperties`), and refuses with HTTP 400 and `application/problem+json`.
- Only the server has dependencies (Express, later the database drivers). The package stays free of them:
  `check:imports` and `check:bundle` (below) prove it on every publish.

## Testing

- **Unit tests** (Vitest) for every part.
- **The standard's own examples:** the 109 JSON examples of tag `cql2-1.0.0`, with the official JSON Schema, in
  `test/fixtures/ogc/` with OGC's licence notice (tests only, not published):
  - the schema accepts every example;
  - the ones in the profile validate and convert to CQL2-text;
  - every other one is refused only as `outside-profile` or `unknown-operator`, naming a conformance class.
- **The grammar:** identifier, keyword, escaping and number cases taken from the BNF.
- **Truth tables:** every operator against a matching value, a non-matching value, a null and a missing property;
  `AND` / `OR` / `NOT` as the standard's tables; case-folding cases.
- **Independent checks,** not part of the repository or of the package:
  - two other CQL2 parsers (cql2-rs, pycql2) read the text output back to the same CQL2-JSON;
  - real OGC API Features servers, comparing the features a server returns with those `ogc-cql2/evaluate` selects
    from the same data.

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
| 0.1.0 | The profile: types, `ogc-cql2/validate`, `ogc-cql2/text`, `ogc-cql2/evaluate`, the playground |
| later | `ogc-cql2/sql` for PostgreSQL; more conformance classes (spatial, temporal, arrays); `ogc-cql2/parse` if a server needs CQL2-text |
