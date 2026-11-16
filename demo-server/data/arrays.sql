-- The arrays table (Array Functions, since 1.6.0): one column per kind of array the postgres dialect compares, and
-- rows with the values where engines disagree. Run after the cql2_* functions exist (load-postgres.sh does it), as
-- the GIN indexes are on them. Safe to run again: it replaces the table.
DROP TABLE IF EXISTS cql2demo.arrays;
CREATE TABLE cql2demo.arrays (
  id integer PRIMARY KEY,
  title text,
  tags text[],                               -- strings
  codes character varying(20)[],             -- strings, in a varchar[] (its own element type)
  ratios double precision[],                 -- numbers
  counts integer[],                          -- integers
  flags boolean[],
  days date[],
  moments timestamp with time zone[],
  doc jsonb,                                 -- a JSON array of any values (declared with items in the config)
  raw json,                                  -- the same, as json
  geom geometry(Point, 4326)
);
COMMENT ON TABLE cql2demo.arrays IS 'Arrays: native PostgreSQL arrays and JSON arrays';

INSERT INTO cql2demo.arrays VALUES
  (1, 'two strings', '{a,b}', '{a,b}', '{1,2.5}', '{1,2}', '{true,false}', '{2010-02-10}',
   '{"2010-02-10 05:30:00.123+00"}', '["a", "b"]', '["a", "b"]', 'SRID=4326;POINT(0 0)'),
  (2, 'repeats, another order', '{b,a,a}', '{b,a,a}', '{2.5,1,1}', '{2,1,1}', '{false,true,true}',
   '{2010-02-10,2010-02-10}', '{"2010-02-10 05:30:00.1234+00","2010-02-10 05:30:00.123+00"}',
   '["b", "a", "a"]', '["b","a","a"]', 'SRID=4326;POINT(1 1)'),
  (3, 'empty', '{}', '{}', '{}', '{}', '{}', '{}', '{}', '[]', '[]', 'SRID=4326;POINT(2 2)'),
  (4, 'NULL', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'SRID=4326;POINT(3 3)'),
  (5, 'NULL elements', '{a,NULL}', '{NULL}', '{NULL,0.1}', '{NULL,1}', '{NULL,true}', '{NULL,2010-02-10}',
   '{NULL}', '["a", null]', '[null]', 'SRID=4326;POINT(4 4)'),
  (6, 'the equality traps', '{"","a ",A}', '{"1"}', '{1.0,-0,0.1}', '{0,-1}', '{true}', '{1969-07-16}',
   '{"1969-07-16 13:32:00+00"}', '["", "a ", "A", "1", 1, true, 1.0]', '[1, "1", true, "true"]', 'SRID=4326;POINT(5 5)'),
  (7, 'Unicode: NFD é, U+E000, an emoji', E'{é,,😀}', E'{é}', '{1e300,-1e300}', '{2147483647}',
   '{false}', '{infinity,2010-02-10}', '{infinity}', E'["é", "é"]', E'["é"]', 'SRID=4326;POINT(6 6)'),
  (8, 'dates and instants as strings', '{2010-02-10,2010-02-10T05:30:00.123Z}', '{2010-02-10}', '{0}', '{0}', '{true}',
   '{2010-02-10,1969-07-16}', '{"2010-02-10 00:00:00+00","2012-08-10 05:30:00+00"}',
   '["2010-02-10", "2010-02-10T05:30:00.123Z", "2012-08-10T05:30:00+00:00"]', '["2010-02-10"]', 'SRID=4326;POINT(7 7)'),
  (9, 'a matrix: no CQL2 array', '{{a,b},{c,d}}', '{{a}}', '{{1}}', '{{1,2}}', '{{true}}', '{{2010-02-10}}',
   '{{"2010-02-10 05:30:00.123+00"}}', '{"not": "an array"}', '"a"', 'SRID=4326;POINT(8 8)'),
  (10, 'JSON: nested, an object, out of range', '{x}', '{x}', '{8}', '{8}', '{true}', '{2010-02-11}',
   '{"2010-02-11 00:00:00+00"}', '[["a"], {"k": 1}, 1e400, 1e-400, "a"]', 'null', 'SRID=4326;POINT(9 9)'),
  (11, 'the standard''s mixed examples', '{a,c}', '{a}', '{1,8}', '{1,8}', '{true}', '{2010-02-10}',
   '{"2012-08-10 05:30:00+00"}', '["a", true, 1.0, 8]', '[8, 1, true, "a"]', 'SRID=4326;POINT(10 10)'),
  (12, 'one of each', '{c}', '{"a "}', '{2.5}', '{2}', '{false}', '{1969-07-16}',
   '{"1969-07-16 13:32:00.0005+00"}', '[false, "2012-08-10T05:30:00Z", "2010-02-10"]', '[]', 'SRID=4326;POINT(11 11)'),
  -- Lower bounds other than 1 (PostgreSQL keeps them, and shows them in its text): the same set of elements.
  (13, 'other lower bounds', '[0:1]={a,b}', '[-2:-2]={b}', '[5:6]={1,2.5}', '[0:0]={1}', '[2:2]={true}',
   '[0:0]={2010-02-10}', '[0:0]={"2010-02-10 05:30:00.123+00"}', '["a", "b"]', '["b"]', 'SRID=4326;POINT(12 12)');

-- The GIN indexes that serve the array functions (see postgresFunctions): on the function the dialect writes.
CREATE INDEX arrays_tags ON cql2demo.arrays USING gin (cql2demo.cql2_text_array(tags));
CREATE INDEX arrays_ratios ON cql2demo.arrays USING gin (cql2demo.cql2_number_array(ratios));
CREATE INDEX arrays_moments ON cql2demo.arrays USING gin (cql2demo.cql2_instant_array(moments));
