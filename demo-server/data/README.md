# Sample data

- `states.geojson`: the 51 US states (50 states and the District of Columbia) with their area and their 1990 and
  1996 population, as distributed in the LuciadRIA sample data (`sampledata/states.json`), free to use. Unchanged:
  numeric ids 1–51 and a `crs` member naming CRS84 (WGS 84 longitude, latitude), from the pre-RFC 7946 GeoJSON.
- `usa.gpkg`: a GeoPackage with two tables, made from the files below by `make-usa-gpkg.sh` with GDAL's `ogr2ogr`:
  - `states`, a features table: the same states, ids and geometry as `states.geojson`, the populations as integers;
  - `sub_regions`, an attributes table (no geometry): the nine census divisions behind the `SUB_REGION` codes.
- `sub_regions.csv` and `sub_regions.csvt`: the divisions, and the CSV's column types for `ogr2ogr`.

To regenerate `usa.gpkg`: `sh make-usa-gpkg.sh` (set `OGR2OGR` to the binary if `ogr2ogr` isn't on the path).
