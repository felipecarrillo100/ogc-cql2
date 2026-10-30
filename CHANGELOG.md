# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor version may change the API.

## [0.0.1] - 2026-10-30

The package's foundation, published to claim the name. No filter functions yet.

### Added

- `ogc-cql2`: `CQL2_VERSION`, the version of the standard the package implements (`"1.0.0"`, OGC 21-065r2).
- `ogc-cql2/text`: `quoteString(value)`, a string as a CQL2-text character literal, in single quotes with each quote
  doubled.
- ESM only, with no runtime dependencies. It runs in browsers and in Node 20 or later, with type declarations for each
  entry point.
- A demo page (`npm run demo`), not part of the published package.

[0.0.1]: https://github.com/felipecarrillo100/ogc-cql2/releases/tag/v0.0.1
