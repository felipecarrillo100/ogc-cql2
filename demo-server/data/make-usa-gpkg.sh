#!/bin/sh
# Builds usa.gpkg, a GeoPackage with two tables, from states.geojson and sub_regions.csv, with GDAL's ogr2ogr:
# - states: a features table; ids kept; the populations stored as INTEGER (ogr2ogr would infer REAL);
# - sub_regions: an attributes table (no geometry); sub_regions.csvt gives its column types;
# - kitchen_sink: kitchen_sink.geojson, with day as DATE, and at and until as DATETIME (always with milliseconds, as
#   the file has them); every other date-like text stays text (DATE_AS_STRING), so the values are exactly the file's.
# Usage: sh make-usa-gpkg.sh   (OGR2OGR=/path/to/ogr2ogr to choose the binary)
set -e
cd "$(dirname "$0")"
OGR2OGR="${OGR2OGR:-ogr2ogr}"
rm -f usa.gpkg
"$OGR2OGR" -f GPKG usa.gpkg states.geojson -nln states -preserve_fid \
  -sql "SELECT AREA, STATE_NAME, STATE_FIPS, SUB_REGION, STATE_ABBR, CAST(POP1990 AS integer) AS POP1990, CAST(POP1996 AS integer) AS POP1996 FROM states" \
  -lco IDENTIFIER="US states" -lco DESCRIPTION="The 50 states and the District of Columbia, with their 1990 and 1996 population"
"$OGR2OGR" -update -f GPKG usa.gpkg sub_regions.csv -nln sub_regions \
  -lco IDENTIFIER="Census sub-regions" -lco DESCRIPTION="The nine US Census divisions, by the codes in states.SUB_REGION"
"$OGR2OGR" -update -f GPKG usa.gpkg kitchen_sink.geojson -oo DATE_AS_STRING=YES -nln kitchen_sink -preserve_fid \
  -sql "SELECT name, code, small, count, big, ratio, amount, active, CAST(day AS date) AS day, CAST(at AS timestamp) AS at, local_at, CAST(until AS timestamp) AS until, note FROM kitchen_sink" \
  -lco DATETIME_PRECISION=MILLISECOND -lco IDENTIFIER="Kitchen sink" -lco DESCRIPTION="Every type and edge case the CQL2 profile can compare"
echo "usa.gpkg: $(wc -c < usa.gpkg | tr -d ' ') bytes"
