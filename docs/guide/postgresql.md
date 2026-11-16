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
- **Literals in another CRS** (since 1.7.0; OGC API Features' `filter-crs`; the rules in
  [Spatial filters](spatial.md#literals-in-another-crs-filter-crs)): see [below](#literals-in-another-crs).
- **`postgresValue(column)`** is what to SELECT for each column, so that what you serve is exactly what the SQL
  compared: dates as `YYYY-MM-DD`, instants as UTC `…Z` with milliseconds, numbers as double precision.
- **Tested on real databases:** thousands of generated filters give the same features from a GeoJSON file
  (`evaluate`), a GeoPackage (SQLite) and PostgreSQL / PostGIS.
- **The classes:** every class the package implements (`sqlConformance({ dialect: "postgres" })`); the spatial ones
  need PostGIS in the database, and the others `postgresFunctions` installed.

## Literals in another CRS

With `literals: { srid: 3857 }`, each literal is read in its SRID and transformed to 4326 in a scalar subquery:

```sql
("geom" && (SELECT ST_Transform(ST_MakeEnvelope($3::double precision, $1::double precision, $4::double precision,
  $2::double precision, 3857), 4326)) AND NOT ST_Relate("geom", (SELECT ST_Transform(…, 4326)), 'FF*FF****'))
```

- **Computed once a query:** without the subquery, PostgreSQL would transform the literal again for every candidate
  row it relates (measured: half the time with it). The GiST index is still used, with parameters and generic plans
  (PostGIS 3.1–3.7).
- **The SRID must be in `spatial_ref_sys`:** PostGIS refuses an SRID it doesn't know (`Invalid reserved SRID`).
- **Axis order:** PostGIS reads every SRID as x, y (EPSG:4326 as longitude first), so give `yx: true` for a
  latitude-first `filter-crs`; the package swaps the numbers before PostGIS reads them.
- **Two literals** compared with each other (S_INTERSECTS of a point and a box) are decided by PostGIS too, after the
  transform. The package decides them itself only in CRS84.
- **Tested on PostGIS 3.1–3.7, amd64 and arm64:** 5,805 literals × 8 relations, in EPSG:3857, EPSG:4326 latitude
  first and UTM 14N, on the US states. Each selects exactly what the same literal, converted to CRS84 by that PostGIS
  and given without `literals`, selects.
  - With GEOS 3.13 or later (PostGIS 3.6, 3.7) it is also exactly what `evaluate` selects with GEOS.
  - Older GEOS (3.9, 3.11) errors (`TopologyException`) or answers differently on geometry nearly touching a
    boundary, in CRS84 as much: that is the database's GEOS, whoever converts.

## Array Functions

- **Native arrays** (`text[]`, `float8[]`, `int4[]`, `boolean[]`, `date[]`, `timestamptz[]`…) need only their
  `sqlType`. A literal of the array's own kind is written with `@>`, `<@` and `&&` on `cql2_text_array(column)` (or
  `cql2_number_array`, `cql2_boolean_array`, `cql2_date_array`, `cql2_instant_array`, all in `postgresFunctions`).
  These read the elements as the dialect compares them: text in NFC, numbers as doubles, instants in UTC to the
  millisecond. They leave NULL elements out, and give NULL for a multi-dimensional array, which isn't a CQL2 array.
- **A GIN index** on that expression serves the four functions:

  ```sql
  CREATE INDEX ON places USING gin (cql2_text_array(tags));
  ```

- **JSON arrays** in `jsonb` or `json` need `items`: `{ sqlType: "jsonb", items: { type: "string" } }`. They are
  compared element by element, each element only with literals of its own JSON type, and no index serves them. A
  value that isn't a JSON array is NULL. A number beyond a double's range reads as infinite (`cql2_json_double`), as
  `JSON.parse` reads it.
- **`postgresValue`** serves a native array as a JSON array of its elements, each by the same rules as a column, and a
  `jsonb` column with `items` as it is.

More on arrays: [Array filters](arrays.md).

More on the spatial rules: [Spatial filters](spatial.md); on infinite dates and timestamps:
[Temporal filters](temporal.md#infinite-dates-and-timestamps).
