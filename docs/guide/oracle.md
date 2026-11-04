# Oracle Database

[Developer guide](index.md) › [SQL backends](sql-backends.md) › Oracle Database

The `oracle` dialect gives the same exact results on Oracle Database 23ai and later (it uses SQL's BOOLEAN), with
Oracle Spatial for the spatial classes. Placeholders are `:1`, `:2` …, each read once, so the values bind by position:

```js
import oracledb from "oracledb";
import { oracleFunctions, oracleValue, toSql } from "ogc-cql2/sql";

const connection = await oracledb.getConnection({ connectString, user, password }); // thin mode: no Oracle client
for (const statement of oracleFunctions()) await connection.execute(statement); // once: cql2_casei, cql2_relate…

const columns = {
  name: { type: "string", sqlType: "VARCHAR2" },
  opened: { type: "string", format: "date-time", sqlType: "TIMESTAMP(6) WITH TIME ZONE" },
  geometry: { format: "geometry-any", sqlType: "SDO_GEOMETRY", column: "GEOM", spatialIndex: true },
};
const { where, params } = toSql(filter, { dialect: "oracle", columns });
const select = Object.entries(columns).map(([name, c]) => `${oracleValue(c.column ?? name, c)} AS "${name}"`).join(", ");
const { rows } = await connection.execute(`SELECT ${select} FROM places WHERE ${where}`, params);
```

- **`sqlType`** is the type as `USER_TAB_COLUMNS` names it (`VARCHAR2`, `NUMBER`, `BINARY_DOUBLE`, `BOOLEAN`, `DATE`,
  `TIMESTAMP(6) WITH TIME ZONE`, `SDO_GEOMETRY`…). Quoted names keep their case: give `column` as the dictionary
  spells it.
- **`oracleFunctions(schema?)`** returns an array of statements, run one at a time (joined with lines holding `/`
  they make a SQL*Plus script). It ends with a COMMIT. They create:
  - the package's tables: case folding, accent marks, and the Unicode composition and combining classes;
  - the package `cql2_support`, which holds those tables in memory;
  - `cql2_casei`, `cql2_accenti`, `cql2_day`, `cql2_instant`, `cql2_arithmetic` (`%` and `^`), `cql2_geometry`,
    `cql2_planar` and `cql2_relate`.
  
  Run it again after an upgrade. It needs the database character set AL32UTF8.
- **Text compares in code point order** whatever the session's `NLS_COMP` and `NLS_SORT`: the parameter carries
  `COLLATE BINARY`, which keeps the column alone on its side, and so its index. NVARCHAR2 and NCHAR compare through
  `TO_CHAR` (UTF-16 would order by code units).
- **Numbers** compare as BINARY_DOUBLE. Literals are bound as text in one format, whatever the session's decimal
  separator: a JavaScript number outside NUMBER's range can't be bound as a number.
- **Dates and instants:**
  - a `TIMESTAMP WITH (LOCAL) TIME ZONE` is an instant, compared as UTC text truncated to milliseconds. Oracle's own
    date arithmetic is Julian before 1582, the text orders right in both calendars;
  - a `DATE` holds a time, so it is a date-time with no zone (text only), unless its queryable says
    `format: "date"`, which reads it as its day;
  - a `TIMESTAMP` is text only.
- **`oracleValue(column)`** is what to SELECT for each column, so that what you serve is exactly what the SQL
  compared: an instant as UTC `…Z`, a DATE as `YYYY-MM-DDTHH:MM:SS` (or its day), numbers as BINARY_DOUBLE.
  - An SDO_GEOMETRY is selected as it is. Read its ordinates as numbers (the driver gives them exactly) and turn them
    into GeoJSON yourself.
  - Don't use `SDO_UTIL.TO_GEOJSON` (15 significant digits) or `TO_WKBGEOMETRY` (which can round to the next double).
- **Spatial filters (Oracle Spatial):**
  - every relation goes through `cql2_relate`: one `SDO_GEOM.RELATE(…, 'DETERMINE', …)`, then the dimensions;
  - it is planar (SRID 4326 is geodetic in Oracle, which isn't CQL2's), with a tolerance of 1e-10;
  - literals are built exactly from their numbers (Oracle's GeoJSON functions keep 15 significant digits);
  - a column in SRID 4326, or with no SRID, is read as CRS84.
- **The spatial index (`spatialIndex: true`):** a planar index on `cql2_planar(column)`, which the SQL then uses
  (`SDO_FILTER`). The column's own SRID 4326 index can't serve: it is geodetic, and loses planar candidates (measured:
  long lines across US states, a box 358° wide). Create it once:

  ```sql
  INSERT INTO user_sdo_geom_metadata VALUES ('PLACES', 'MYSCHEMA.CQL2_PLANAR(GEOM)',
    SDO_DIM_ARRAY(SDO_DIM_ELEMENT('X', -180, 180, 1e-10), SDO_DIM_ELEMENT('Y', -90, 90, 1e-10)), NULL);
  CREATE INDEX places_planar ON places (cql2_planar(geom)) INDEXTYPE IS MDSYS.SPATIAL_INDEX_V2;
  ```

**Where Oracle differs, documented:**
- **`''` is NULL in Oracle**, so no column holds it. A comparison with an empty string literal is decided when the
  SQL is built, as `evaluate` decides it on the served values. A value made only of accent marks is `''` under
  ACCENTI in `evaluate`, and NULL in Oracle.
- **Stored text is assumed to be in NFC:** Oracle's `COMPOSE` isn't Unicode's NFC. CASEI and ACCENTI normalize with
  the package's own tables. Characters added after Unicode 15.0.0 are decomposed by the database's own Unicode
  version, so they can compare differently, as between the other engines.
- **The tolerance:** geometries within 1e-10 of each other's boundary may be decided either way. Measured: only
  points within 1.4e-14° of a US state's boundary: 27 answers in 46,440 queries.
- **A GeometryCollection whose own members meet** (overlap or touch) is read with each member's boundary: for it, the
  relations but S_INTERSECTS and S_DISJOINT can differ from GEOS.
- **Limits:** a folded string, or an NVARCHAR2 value as VARCHAR2, can't be longer than 4,000 bytes with
  `MAX_STRING_SIZE = STANDARD`. A longer one makes the query fail; it never gives a wrong answer.
- **The session's `NLS_CALENDAR` must be GREGORIAN** (Oracle's default).

- **Tested on real databases:** thousands of generated filters give the same features from Oracle as from `evaluate`
  on what Oracle serves, every spatial relation with GEOS (demo-server's tests, against Oracle Free 23ai; not in CI).
- **The classes:** every class the package implements (`sqlConformance({ dialect: "oracle" })`); the spatial ones
  need Oracle Spatial, and all need `oracleFunctions` installed.
