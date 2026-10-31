# Natural Earth 1:110m, for the standard's spatial acceptance tests

The three datasets of CQL2 1.0.0's conformance tests for Basic Spatial Functions (OGC 21-065r2, Annex A.7, Table 12)
and Spatial Functions (Annex A.9.9, Table 14), used by `test/naturalearth.test.ts`. Tests only; not part of the npm
package.

- Source: Natural Earth (https://www.naturalearthdata.com), the shapefiles of
  https://github.com/nvkelso/natural-earth-vector (`110m_cultural/`, `110m_physical/`), version 5.2.0-pre,
  downloaded 2026-10-31. Licence: public domain ("Natural Earth is in the public domain").
- Converted at full precision (the repository's own GeoJSON rounds to 6 or 7 decimals, which moves the vertices that
  Table 14's S_EQUALS and S_TOUCHES literals sit on), keeping only the name, to save space:

  ```sh
  ogr2ogr -f GeoJSON ne_110m_admin_0_countries.geojson ne_110m_admin_0_countries.shp \
    -sql 'SELECT "NAME" AS name FROM ne_110m_admin_0_countries' -lco RFC7946=NO -lco WRITE_NAME=NO -lco SIGNIFICANT_FIGURES=17
  ```

  The same for the two others, whose field is `name`. GDAL 3.8.5.
