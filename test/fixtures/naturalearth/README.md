# Natural Earth 1:110m, for the standard's spatial acceptance test

The three datasets of CQL2 1.0.0's conformance test for Basic Spatial Functions (OGC 21-065r2, Annex A.7, Table 12),
used by `test/naturalearth.test.ts`. Tests only; not part of the npm package.

- Source: Natural Earth (https://www.naturalearthdata.com), the GeoJSON of
  https://github.com/nvkelso/natural-earth-vector (`geojson/`), version 5.2.0-pre, downloaded 2026-10-31.
- Licence: public domain ("Natural Earth is in the public domain").
- Changed: the geometries are kept exactly as published; of the properties only the name is kept, to save space.
