-- The kitchen sink in PostgreSQL types; load-postgres.sh fills it from kitchen_sink.geojson.
SET client_min_messages = warning;
DROP TABLE IF EXISTS cql2demo.kitchen_sink_3857;
DROP TABLE IF EXISTS cql2demo.kitchen_sink;
CREATE TABLE cql2demo.kitchen_sink (
  id integer PRIMARY KEY,
  name text,
  code varchar(10),
  small smallint,
  count integer,
  big bigint,
  ratio double precision,
  amount numeric(12, 2),
  active boolean,
  day date,
  at timestamptz,
  local_at timestamp,
  note text,
  geom geometry(Geometry, 4326)
);
COMMENT ON TABLE cql2demo.kitchen_sink IS 'Every type and edge case the CQL2 profile can compare';
