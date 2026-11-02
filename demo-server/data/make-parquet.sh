#!/bin/sh
# Builds the GeoParquet files (GeoParquet 1.1, with a bbox covering) with GDAL's ogr2ogr (tested with GDAL 3.13):
# - kitchen_sink.parquet: kitchen_sink.geojson, the ids kept; GDAL reads its dates and instants as DATE,
#   TIMESTAMP WITH TIME ZONE and TIMESTAMP (without a time zone), every other value as the file has it;
# - states.parquet: usa.gpkg's states table, ids and types as there.
# The polygon rings keep the order they have (GDAL would otherwise rewrite them counterclockwise), so the geometry is
# exactly the source's. GDAL's covering (geometry_bbox, float32) is rounded outward, as GeoParquet requires.
# Usage: sh make-parquet.sh   (OGR2OGR=/path/to/ogr2ogr to choose the binary)
set -e
cd "$(dirname "$0")"
OGR2OGR="${OGR2OGR:-ogr2ogr}"
rm -f kitchen_sink.parquet states.parquet
"$OGR2OGR" -f Parquet kitchen_sink.parquet kitchen_sink.geojson -preserve_fid -lco FID=id -lco POLYGON_ORIENTATION=UNMODIFIED
"$OGR2OGR" -f Parquet states.parquet usa.gpkg states -preserve_fid -lco FID=id -lco POLYGON_ORIENTATION=UNMODIFIED
echo "kitchen_sink.parquet: $(wc -c < kitchen_sink.parquet | tr -d ' ') bytes, states.parquet: $(wc -c < states.parquet | tr -d ' ') bytes"
