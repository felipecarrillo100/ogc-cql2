# PostgreSQL and PostGIS

[Developer guide](index.md) › [SQL backends](sql-backends.md) › PostgreSQL and PostGIS

The `postgres` dialect gives the same exact results on PostgreSQL (and PostGIS tables), with `$1`, `$2` … placeholders:

```js
import pg from "pg";
import { postgresFunctions, postgresValue, toSql } from "ogc-cql2/sql";

const client = new pg.Client(); // the connection from PGHOST, PGDATABASE, PGUSER, PGPASSWORD…
await client.connect();
await client.query(postgresFunctions("myschema")); // once: creates cql2_casei, cql2_accenti, cql2_day… there

const columns = {
  name: { type: "string", sqlType: "text" },
  opened: { type: "string", format: "date-time", sqlType: "timestamp with time zone" },
};
const { where, params } = toSql(filter, { dialect: "postgres", columns, functionSchema: "myschema" });
const select = Object.entries(columns).map(([name, c]) => `${postgresValue(name, c)} AS "${name}"`).join(", ");
const { rows } = await client.query(`SELECT ${select} FROM myschema.places WHERE ${where}`, params);
```

- **`sqlType`** is the column's declared PostgreSQL type; it decides how the column is compared.
- **Text compares in code point order** (`COLLATE "C"`) after NFC normalization: the database's own collation sorts by
  language rules, which CQL2 doesn't.
- **`postgresFunctions(schema)`** returns the SQL to run once: Unicode full case folding for CASEI (PostgreSQL's
  `lower()` isn't), accent removal for ACCENTI (PostgreSQL's `unaccent` extension follows a dictionary instead: it
  turns `ø` into `o`), strict readers of dates and instants in text columns, and (since 1.2.0) `cql2_arithmetic` for
  arithmetic expressions. It needs no extension, only the right to create objects in that schema. Run it again after
  an upgrade that adds a function.
- **Spatial filters (PostGIS):** give the geometry column as `{ sqlType: "geometry", column: "geom" }` (or
  `geometry(MultiPolygon, 4326)`, `geography`). `s_intersects` becomes `geom && literal AND NOT ST_Relate(geom,
  literal, 'FF*FF****')`: the box test uses the GiST index, and GEOS's DE-9IM matrix decides exactly, as `evaluate`
  does. PostGIS's own `ST_Intersects`, and from PostGIS 3.7 `ST_Disjoint`, aren't used: on arm64 machines (Apple
  Silicon, AWS Graviton) they miss a point lying exactly on an edge. A GeometryCollection literal is tested member by
  member, which GEOS 3.11 needs; a column holding GeometryCollections needs GEOS 3.13 or later (3.9 works too).
- **The other relations (Spatial Functions):** `ST_Equals`, and `ST_Touches` / `ST_Overlaps` / `ST_Crosses` behind
  `&&`; `s_within` and `s_contains` as `geom @ literal AND ST_Relate(geom, literal, 'T*F**F***')` and `geom ~ literal
  AND ST_Relate(…, 'T*****FF*')`, since `ST_Within` and `ST_Contains` take the same point-in-polygon shortcut;
  `s_disjoint` as the negation of `s_intersects`. Each uses the GiST index but `s_disjoint`, which no index can
  speed up. A box across the antimeridian is one literal, its two halves collected.
- **Another SRID, or geography:** a column in another SRID (`srid: 3857`, or `geometry(Point, 3857)`) is transformed
  to 4326, so the comparison is planar in CRS84, as CQL2's is; a geography column is read as geometry. Neither can
  use a plain index on the column, so give it an expression index, which the SQL then uses:

  ```sql
  CREATE INDEX ON places USING GIST (ST_Transform(geom, 4326)); -- a column in another SRID
  CREATE INDEX ON places USING GIST ((geog::geometry));          -- a geography column
  ```

  Data stored in another CRS isn't exact on its original vertices any more (5 comes back as 4.999999999999998).
- **`postgresValue(column)`** is what to SELECT for each column, so that what you serve is exactly what the SQL
  compared: dates as `YYYY-MM-DD`, instants as UTC `…Z` with milliseconds, numbers as double precision.
- **Tested on real databases:** thousands of generated filters give the same features from a GeoJSON file
  (`evaluate`), a GeoPackage (SQLite) and PostgreSQL / PostGIS.
- **The classes:** every class the package implements (`sqlConformance({ dialect: "postgres" })`); the spatial ones
  need PostGIS in the database, and the others `postgresFunctions` installed.

More on the spatial rules: [Spatial filters](spatial.md); on infinite dates and timestamps:
[Temporal filters](temporal.md#infinite-dates-and-timestamps).
