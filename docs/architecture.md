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
| `ogc-cql2/validate` | `src/validate/` | `validate`, `assertValid`, `requiredConformance` | 0.1.0 |
| `ogc-cql2/text` | `src/text/` | `toText`, `textProblem`, `isIdentifier`, `quoteString` | 0.1.0 |
| `ogc-cql2/evaluate` | `src/evaluate/` | `toPredicate`, `toEvaluator`, `evaluate` | 0.1.0 |
| `ogc-cql2/sql` | `src/sql/` | CQL2-JSON → parameterized SQL (PostgreSQL / PostGIS first) | later |
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

### SQL (`ogc-cql2/sql`, later)

- **Always parameterized:** values become `$1`, `$2` …, never text inside the query.
- **Property names are checked** against the columns the caller allows, then quoted.
- **CQL2's three-valued logic maps directly** onto SQL's NULL.

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
  - evaluates it against stored features (`ogc-cql2/evaluate`), or later builds SQL (`ogc-cql2/sql`);
  - and, if it must accept CQL2-text, parses it (`ogc-cql2/parse`, later).

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

Adding an entry point means adding it in two places: `tsdown.config.ts` and `exports` in `package.json`. publint
checks that they agree.

## Roadmap

| Version | What |
|---|---|
| 0.0.1 | The foundation: build, tests, demo, `CQL2_VERSION`, `quoteString` |
| 0.1.0 | The profile: types, `ogc-cql2/validate`, `ogc-cql2/text`, `ogc-cql2/evaluate`, the playground |
| later | `ogc-cql2/sql`; more conformance classes (spatial, temporal, arrays); `ogc-cql2/parse` if a server needs CQL2-text |
