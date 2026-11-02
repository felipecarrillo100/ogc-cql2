#!/bin/sh
# Loads the sample tables into schema cql2demo, as the demo's user, from the connection in ../.env:
# - kitchen_sink (kitchen_sink.sql, then filled from kitchen_sink.geojson), and kitchen_sink_3857, the same rows in
#   Web Mercator;
# - states and sub_regions, from usa.gpkg, column names kept as they are;
# - ogc-cql2's cql2_* functions (postgresFunctions), which the postgres dialect calls.
# Prerequisite: setup-postgres-admin.sql, run once by a superuser. Safe to run again: it replaces the tables.
# Usage: sh load-postgres.sh   (PSQL / OGR2OGR to choose the binaries; the package must be built: npm start does it)
set -e
cd "$(dirname "$0")"
set -a
[ -f ../.env ] && . ../.env
set +a
PSQL="${PSQL:-psql}"
OGR2OGR="${OGR2OGR:-ogr2ogr}"
PG="PG:dbname='${PGDATABASE}'"
export PGOPTIONS="-c client_min_messages=warning" # no NOTICEs for objects that are replaced

"$PSQL" -X -q -v ON_ERROR_STOP=1 -f kitchen_sink.sql
"$OGR2OGR" -append -f PostgreSQL "$PG" kitchen_sink.geojson -oo DATE_AS_STRING=YES -nln cql2demo.kitchen_sink -preserve_fid
"$PSQL" -X -q -v ON_ERROR_STOP=1 -c "
  CREATE TABLE cql2demo.kitchen_sink_3857 AS
    SELECT id, name, code, small, count, big, ratio, amount, active, day, at, local_at, until, note,
           ST_Transform(geom, 3857)::geometry(Geometry, 3857) AS geom
    FROM cql2demo.kitchen_sink;
  ALTER TABLE cql2demo.kitchen_sink_3857 ADD PRIMARY KEY (id);
  COMMENT ON TABLE cql2demo.kitchen_sink_3857 IS 'The kitchen sink in Web Mercator (EPSG:3857)';"
"$OGR2OGR" -f PostgreSQL "$PG" usa.gpkg states sub_regions -preserve_fid -lco OVERWRITE=YES \
  -lco SCHEMA=cql2demo -lco FID=fid -lco GEOMETRY_NAME=geom -lco LAUNDER=NO
(cd .. && node --input-type=module -e "process.stdout.write((await import('ogc-cql2/sql')).postgresFunctions('cql2demo'))") \
  | "$PSQL" -X -q -v ON_ERROR_STOP=1
for table in kitchen_sink kitchen_sink_3857 states sub_regions cql2_casefold; do
  "$PSQL" -X -At -c "SELECT 'cql2demo.$table: ' || count(*) FROM cql2demo.$table"
done
