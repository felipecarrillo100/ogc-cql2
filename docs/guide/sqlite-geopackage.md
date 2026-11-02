# SQLite and GeoPackage

[Developer guide](index.md) › [SQL backends](sql-backends.md) › SQLite and GeoPackage

The `sqlite` dialect, with `?` placeholders, follows **GeoPackage** (OGC 12-128r19), OGC's standard for data in
SQLite. In Node, with the built-in `node:sqlite`:

```js
import { DatabaseSync } from "node:sqlite";
import { sqliteFunctions, toSql } from "ogc-cql2/sql";

const db = new DatabaseSync("data.gpkg");
for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn);

const columns = { name: { type: "string" }, population: { type: "integer" } }; // the table's queryables
const { where, params } = toSql(filter, { dialect: "sqlite", columns });
const rows = db.prepare(`SELECT * FROM places WHERE ${where}`).all(...params);
```

- **Exactly what `evaluate` selects.** The SQL follows the same rules, NULL, no type conversion, NFC, CASEI's case
  folding, case-sensitive LIKE, and the tests check that on a real SQLite database.
- **Columns follow GeoPackage:** give each column's type as its queryable (`BOOLEAN` → `boolean`, `INTEGER` →
  `integer`, `DOUBLE` → `number`, `TEXT` → `string`, `DATE` → `string` with `format: "date"`, `DATETIME` → `string`
  with `format: "date-time"`). BOOLEAN is GeoPackage's 0 / 1, so read those values back as `false` / `true`.
- **Register `sqliteFunctions` on the connection.** They run the package's own text, case-folding, LIKE, date-time and
  arithmetic rules inside SQLite, whose built-in LIKE ignores ASCII case and whose `lower()` folds ASCII only.
- **Safe by construction:** values are always `?` parameters, and a property that isn't in `columns` is refused
  (`unknown-property`), so no name reaches the SQL unchecked.
- **The cost of exactness:** SQLite can't use an index for these predicates, because each value's type is checked as
  it is read (GeoPackage tells readers to allow for values of an unexpected type).
- **The classes:** every class but Spatial Functions; with SpatiaLite (below), every class.
  `sqlConformance({ dialect: "sqlite", spatialite })` says so in code.

## Spatial filters

- **`s_intersects`:** give the geometry column as `{ format: "geometry-any", column: "geom" }` (any `geometry-…`
  format). Its values are GeoPackage blobs, or plain WKB; `cql2_intersects` (in `sqliteFunctions`) decides with
  `evaluate`'s own engine, so exactly as `evaluate` does, and a blob's header envelope rejects most rows before the
  geometry is read.
- **GeoPackage's R-tree:** give its table too, `rtree: "rtree_places_geom"`: the candidates then come from it (on a
  million rows, a small box took 3 ms instead of 811 ms). The R-tree holds no NULL or empty geometries, so it is used
  only where that changes no answer, outside a NOT: negate the filter (`{ op: "not" }`), never the SQL it gives.
- **The Spatial Functions class needs SpatiaLite:** load `mod_spatialite` on the connection and pass
  `spatialite: true`; GEOS then decides each relation, exactly as `evaluate` with GEOS does. SpatiaLite reads
  GeoPackage blobs itself; anything it can't read (WKB, empty geometries) goes through `cql2_wkt`, the package's own
  reader. The R-tree applies as for `s_intersects`. A GeometryCollection literal needs SpatiaLite built with GEOS 3.13
  or later: with GEOS 3.12 (Ubuntu 24.04's), S_TOUCHES and S_OVERLAPS against a collection of a point and a line
  select other rows than `evaluate`. Without SpatiaLite, the class is refused (`unsupported`), `s_disjoint` included.

  ```js
  const db = new DatabaseSync("places.gpkg", { allowExtension: true });
  db.loadExtension("mod_spatialite"); // its path where the loader doesn't look, e.g. "/opt/homebrew/lib/mod_spatialite"
  const { where, params } = toSql(filter, { dialect: "sqlite", columns, spatialite: true });
  ```

- **Two geometry columns** are compared with `cql2_intersects_pair` (in `sqliteFunctions`), and with SpatiaLite for
  the other relations.

More on the spatial rules: [Spatial filters](spatial.md).
