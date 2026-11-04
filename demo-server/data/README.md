# Sample data

- `states.geojson`: the 51 US states (50 states and the District of Columbia) with their area and their 1990 and
  1996 population, as distributed in the LuciadRIA sample data (`sampledata/states.json`), free to use. Unchanged:
  numeric ids 1–51 and a `crs` member naming CRS84 (WGS 84 longitude, latitude), from the pre-RFC 7946 GeoJSON.
- `usa.gpkg`: a GeoPackage with two tables, made from the files below by `make-usa-gpkg.sh` with GDAL's `ogr2ogr`:
  - `states`, a features table: the same states, ids and geometry as `states.geojson`, the populations as integers;
  - `sub_regions`, an attributes table (no geometry): the nine census divisions behind the `SUB_REGION` codes.
- `sub_regions.csv` and `sub_regions.csvt`: the divisions, and the CSV's column types for `ogr2ogr`.

To regenerate `usa.gpkg`: `sh make-usa-gpkg.sh` (set `OGR2OGR` to the binary if `ogr2ogr` isn't on the path).
- `kitchen_sink.parquet` and `states.parquet`: the kitchen sink and the states as GeoParquet 1.1 files, with GDAL's
  bbox covering, made by `make-parquet.sh` with GDAL's `ogr2ogr` (3.13): the ids, every value and every geometry
  (rings in their order) as in their sources, `kitchen_sink.geojson` and `usa.gpkg`. Served by DuckDB.
  To regenerate them: `sh make-parquet.sh`.
- `kitchen_sink.geojson`: every type and edge case the profile can compare (Unicode in NFC and NFD, `ß`, Greek,
  `İ`, `ﬁ`, emoji, U+E000, LIKE's `%` `_` `\`, integers up to 2⁵³ − 1, decimals, booleans, dates, UTC instants with
  milliseconds, periods from `at` to `until` (equal ends, NULL ends, one ending before it begins), local times without
  an offset, text that looks like dates and numbers, every geometry type, NULLs in every column). The
  same rows go into `usa.gpkg`, `kitchen_sink.parquet` and PostgreSQL, so every store must answer alike.

## PostgreSQL

The connection is in `demo-server/.env` (copy `.env_sample`). Then, once:

1. As a superuser, in that database: `psql -U postgres -d apipeatures -f setup-postgres-admin.sql`. It installs
   PostGIS and creates the schema `cql2demo`, owned by the demo's user.
2. As the demo's user: `sh load-postgres.sh`. It creates the tables in `cql2demo` (`kitchen_sink` from
   `kitchen_sink.sql` and `kitchen_sink.geojson`, `kitchen_sink_3857` in Web Mercator, `states` and `sub_regions` from
   `usa.gpkg`) and ogc-cql2's `cql2_*` functions. Safe to run again. Set `PSQL` / `OGR2OGR` if those aren't on the
   path; with Postgres.app they are in `/Applications/Postgres.app/Contents/Versions/17/bin`.

## Oracle

The connection is in `demo-server/.env` (`ORACLE_CONNECT` as `host:port/service`, `ORACLE_USER`, `ORACLE_PASSWORD`),
for Oracle Database 23ai or later with Oracle Spatial (the Free edition's full image has it; its slim image doesn't).
Then, once, as that user: `node --env-file-if-exists=.env data/load-oracle.ts` (from `demo-server`, the package
built). It creates `KITCHEN_SINK` and `KITCHEN_SINK_PLAIN` (the same rows, without spatial metadata or index) from
`kitchen_sink.geojson`, `STATES` from `states.geojson`, the planar spatial indexes the `oracle` dialect uses, and
ogc-cql2's `cql2_*` functions. Text is stored in NFC; Oracle stores `''` as NULL. Safe to run again.

## SQL Server

The connection is in `demo-server/.env` (`MSSQL_SERVER`, `MSSQL_PORT`, `MSSQL_DATABASE`, `MSSQL_USER`,
`MSSQL_PASSWORD`, and `MSSQL_ENCRYPT=false` for a server without TLS), for SQL Server 2022 or later. Then, once:
`node --env-file-if-exists=.env data/load-sqlserver.ts` (from `demo-server`, the package built). It creates
`dbo.kitchen_sink` (three kinds of text column: nvarchar with a supplementary-character collation, varchar UTF-8, and
nvarchar in the database's default collation), `dbo.states`, their spatial indexes, `dbo.bin2_text` (a column the store
leaves out) and ogc-cql2's `cql2_*` functions. Text is stored in NFC. Safe to run again.
