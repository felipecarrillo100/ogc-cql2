# OGC fixtures

Copied unchanged from the CQL2 1.0.0 release of the OGC API - Features repository
(github.com/opengeospatial/ogcapi-features, tag `cql2-1.0.0`):

- `cql2.json`: the CQL2 JSON Schema, `cql2/standard/schema/cql2.json`;
- `examples/json/`, `examples/text/`: the standard's examples, `cql2/standard/schema/examples/`, without the
  `validate.sh` helper script;
- `LICENSE`: OGC's licence for them, which requires keeping its notice.

They are used by the tests only and are not part of the published package.

## Modified

- `data/ne_110m_populated_places_simple.geojson`: the columns of `ne_110m_populated_places_simple` that the
  Property-Property Comparisons test (Annex A.12, Table 16) uses, from the standard's test data,
  `cql2/standard/data/ne110m4cql2.gpkg` at the same tag: the `fid` as the id, `name`, `nameascii`, `pop_min`,
  `pop_max`, `pop_other`, `start` and `end`, without geometry. **This file includes modifications that have not been
  approved or adopted by OGC:** the columns were extracted to GeoJSON, and a `Z` was added to the three `start` and
  three `end` values, which the GeoPackage stores as DATETIME without one (GeoPackage's DATETIME is UTC, written with
  a `Z`).
