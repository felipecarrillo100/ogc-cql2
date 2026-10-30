#!/bin/sh
# Builds usa.gpkg, a GeoPackage with two tables, from states.geojson and sub_regions.csv, with GDAL's ogr2ogr:
# - states: a features table; ids kept; the populations stored as INTEGER (ogr2ogr would infer REAL);
# - sub_regions: an attributes table (no geometry); sub_regions.csvt gives its column types.
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
echo "usa.gpkg: $(wc -c < usa.gpkg | tr -d ' ') bytes"
