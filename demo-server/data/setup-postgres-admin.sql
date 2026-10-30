-- Run once, as a PostgreSQL superuser (e.g. postgres), connected to the demo's database:
--   psql -U postgres -d apipeatures -f setup-postgres-admin.sql
-- PostGIS for the geometry, and a schema the demo's user owns, where load-postgres.sh puts the sample tables and
-- ogc-cql2's cql2_* functions. Safe to run again. Nothing else in the database is touched.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS cql2demo AUTHORIZATION apipeatures;
