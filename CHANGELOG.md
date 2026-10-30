# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor version may change the API.

## [0.1.0] - 2026-10-30

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
  folding for `casei` and NFC normalization for strings.
- The MIT licence, and `LICENSE-UNICODE` for the case-folding table derived from Unicode data.
- The demo is now a playground: a CQL2-JSON filter, its problems, conformance classes, CQL2-text and the sample
  features it selects, in the browser or from `demo-server`.
- `demo-server/` (not published): a Node backend answering filters from GeoJSON files, through a store layer.
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

[0.1.0]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.1.0
[0.0.1]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.0.1
