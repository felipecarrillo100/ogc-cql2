# Architecture

The design as of 0.0.1. Most of it is planned, not built yet; the status column says which. For the reasons behind
it, see [vision.md](vision.md).

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

## Entry points

Each part is its own entry point, with its own folder under `src/`. A part imports only what it needs, so a bundler
drops the rest.

| Import | Folder | Gives | Status |
|---|---|---|---|
| `ogc-cql2` | `src/` + `src/core/` | The TypeScript types for CQL2-JSON in the profile; the error class and its codes; small helpers that build filters; `CQL2_VERSION` | `CQL2_VERSION` only |
| `ogc-cql2/validate` | `src/validate/` | Checks a filter against the profile. Every problem comes with a code, a reason and where in the filter it is | planned (0.1.0) |
| `ogc-cql2/text` | `src/text/` | CQL2-JSON → CQL2-text, for the `filter` parameter of OGC API Features Part 3 | `quoteString` only; the encoder is planned (0.1.0) |
| `ogc-cql2/evaluate` | `src/evaluate/` | Tests features against a filter in memory, with the standard's three-valued logic | planned (0.1.0) |
| `ogc-cql2/sql` | `src/sql/` | CQL2-JSON → parameterized SQL (PostgreSQL / PostGIS first) | later |
| `ogc-cql2/parse` | `src/parse/` | CQL2-text → CQL2-JSON, for a server that receives text | later, if needed |

## The parts

### Validation (`ogc-cql2/validate`)

- **It is hand-written for the profile,** with no JSON Schema library at run time.
- **It checks more than the schema can.** The official JSON Schema accepts any unknown operator as a custom function
  call, so the schema alone can't tell a typo from a function. The profile check rejects every operator and function
  outside the declared classes, with the reason.
- **The official schema is used in the tests,** to show that every filter the check accepts, the schema accepts too.

### CQL2-text (`ogc-cql2/text`)

It follows the text encoding's grammar exactly:
- **identifiers:** a property name that is not a valid identifier in the BNF, or that equals one of the standard's
  keywords, is written in double quotes;
- **character literals:** in single quotes, with each quote doubled (`quoteString`);
- **`LIKE` patterns:** `%` and `_` are the wildcards, with the standard's escaping rules;
- **numbers:** in the standard's form, including the exponent `E`;
- **dates and timestamps:** as `DATE('…')` and `TIMESTAMP('…')`;
- **anything the text encoding can't express is refused,** with a reason. Nothing is approximated.

### Evaluation (`ogc-cql2/evaluate`)

- **Three-valued logic,** following the standard:
  - a comparison, `LIKE` or `BETWEEN` on a missing or null value is *unknown*;
  - `IS NULL` is never unknown;
  - `AND` follows the standard's Table 2, and `NOT` its Table 3;
  - a feature is selected only when the result is *true*.
- **Features are plain objects** with `properties`, like GeoJSON. The function that reads a property can be replaced,
  for other feature shapes.
- **What the standard leaves to the system,** such as comparing values of different types, is documented in the
  code where it is decided.

### SQL (`ogc-cql2/sql`, later)

- **Always parameterized:** values become `$1`, `$2` …, never text inside the query.
- **Property names are checked** against the columns the caller allows, then quoted.
- **CQL2's three-valued logic maps directly** onto SQL's NULL.

### Errors

- **Every refusal is a `Cql2Error`** with a stable `code` string (for example `cql2.unknown-operator`), a message and,
  when it applies, the path inside the filter.
- **Callers test the `code`, not `instanceof`.** That keeps working even when two copies of the package end up in one
  application.

## How it is used

- **A client application:**
  - keeps its filters as CQL2-JSON;
  - validates them;
  - sends `ogc-cql2/text` output to OGC API Features servers;
  - and filters features it already holds with `ogc-cql2/evaluate`.
- **Other filter languages:** an application that also needs, for example, OGC Filter Encoding for WFS, translates
  from the same CQL2-JSON in its own code. Such translations are outside this package.
- **A Node server:**
  - accepts CQL2-JSON;
  - validates it;
  - evaluates it against stored features (`ogc-cql2/evaluate`), or later builds SQL (`ogc-cql2/sql`);
  - and, if it must accept CQL2-text, parses it (`ogc-cql2/parse`, later).

## Testing

- **Unit tests** (Vitest) for every part.
- **The standard's own examples:** the text and JSON pairs in the CQL2 repository, as fixtures in `test/fixtures/`.
- **The grammar:** identifier, keyword, escaping and number cases taken from the BNF.
- **Truth tables:** every operator against a matching value, a non-matching value, a null and a missing property;
  `AND` / `OR` / `NOT` as the standard's tables.
- **Independent checks,** not part of the repository or of the package:
  - other CQL2 parsers, used to cross-check the text output;
  - and real OGC API Features servers, used to compare the features a server returns with those `ogc-cql2/evaluate`
    selects from the same data.

## Build and tooling

| Job | Tool |
|---|---|
| Build | tsdown: ESM, one output file per source module (`unbundle`), `.d.ts` files generated with `isolatedDeclarations` |
| Package checks | publint and arethetypeswrong, run with every build |
| Typecheck | TypeScript 7. `tsconfig.json` checks `src/` without DOM types, so the sources also run in Node; `tsconfig.dev.json` checks the tests, the demo and the config files |
| Tests | Vitest |
| Demo | Vite, importing the package by name, aliased to `src/` |

Adding an entry point means adding it in two places: `tsdown.config.ts` and `exports` in `package.json`. publint
checks that they agree.

## Roadmap

| Version | What |
|---|---|
| 0.0.1 | The foundation: build, tests, demo, `CQL2_VERSION`, `quoteString` |
| 0.1.0 | The profile: types, `ogc-cql2/validate`, `ogc-cql2/text`, `ogc-cql2/evaluate` |
| later | `ogc-cql2/sql`; more conformance classes (spatial, temporal, arrays); `ogc-cql2/parse` if a server needs CQL2-text |
