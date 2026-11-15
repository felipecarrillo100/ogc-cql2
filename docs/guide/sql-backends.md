# SQL backends

[Developer guide](index.md) › SQL backends

`ogc-cql2/sql` turns a filter into a parameterized `WHERE` clause for SQLite / GeoPackage, PostgreSQL / PostGIS,
DuckDB, Oracle Database or SQL Server. It only builds the text and the values; your code runs them with its own driver, so the package still has no
dependencies.

```js
import { toSql } from "ogc-cql2/sql";

const columns = { name: { type: "string" }, population: { type: "integer" } }; // the table's queryables
const { where, params } = toSql(filter, { dialect: "sqlite", columns });
// where: a condition with ? placeholders (sqlite), $1, $2 … (postgres, duckdb), :1, :2 … (oracle) or @p1, @p2 …
// (sqlserver); params: their values, in order
```

- **Exactly what `evaluate` selects.** The SQL follows the same rules (NULL, no type conversion, NFC, CASEI's case
  folding, case-sensitive LIKE), and the tests check that on real databases, filter by filter.
- **`columns` are the table's queryables:** each column's type, as its queryable gives it, decides how it is compared.
  A property can map to a column of another name (`column`); each dialect adds keys of its own (`sqlType`, `rtree`,
  `covering`…, on its page).
- **Safe by construction:** values are always parameters, never text in the query, and a property that isn't in
  `columns` is refused (`unknown-property`), so no name reaches the SQL unchecked.
- **Each database needs the package's functions** registered or installed once (`sqliteFunctions`,
  `postgresFunctions`, `duckdbFunctions`, `oracleFunctions`, `sqlserverFunctions`), and a SELECT of each column as the
  dialect compares it (`postgresValue`, `duckdbValue`, `oracleValue`, `sqlserverValue`), so that what you serve is
  exactly what the SQL compared.

The setup and the rules of each database:
- [SQLite and GeoPackage](sqlite-geopackage.md)
- [PostgreSQL and PostGIS](postgresql.md)
- [DuckDB](duckdb.md), in Node and in the browser
- [Oracle Database](oracle.md)
- [SQL Server](sqlserver.md)

## The classes each dialect supports

`sqlConformance(options)` returns the conformance classes `toSql` translates with those options, as URIs, the way a
server declares them. It takes `toSql`'s options (without `columns`, if you like):

```js
import { sqlConformance, toSql } from "ogc-cql2/sql";
import { validate } from "ogc-cql2/validate";

const options = { dialect: "sqlite", spatialite: true, columns };
const conformance = sqlConformance(options);

const result = validate(filter, { conformance, queryables: columns });
if (result.valid) {
  const { where, params } = toSql(result.filter, options); // never `unsupported`
}
```

- **`postgres`, `duckdb` and `oracle`:** every class the package implements. **`sqlite`:** every class but Spatial
  Functions, unless `spatialite` is `true`. **`sqlserver`:** every class but Spatial Functions (S_DISJOINT is one of
  them: write NOT S_INTERSECTS).
- **The promise:** a filter `validate` accepts against that list is never refused as `unsupported` with the same
  options. One it refuses as `needs-conformance` would be.
- **The list grows** with minor versions, as the package implements classes.
- **It is a plain new array,** in `CONFORMANCE`'s order, to change at will.

## Publishing an honest `/conformance`

A server built on `toSql` declares what it serves at `/conformance` (OGC API Features Part 1). Start from
`sqlConformance`, then adjust it to what your setup really has:

```js
const classes = sqlConformance({ dialect: "postgres" });

app.get("/conformance", (req, res) => res.json({
  conformsTo: [
    ...ogcApiClasses, // the OGC API Features classes your server implements
    "http://www.opengis.net/spec/cql2/1.0/conf/cql2-json",
    "http://www.opengis.net/spec/cql2/1.0/conf/cql2-text",
    ...classes,
  ],
}));
```

- **The list says what the package's SQL needs, not what the database has.** The spatial classes also need PostGIS
  on PostgreSQL, DuckDB's spatial extension loaded, or Oracle Spatial; every dialect needs the package's functions installed; a
  GeometryCollection literal needs GEOS 3.13 or later. Leave out what your database lacks.
- **The encodings aren't in it:** `cql2-json` and `cql2-text` name an encoding, not something a filter needs. Declare
  the ones you accept (with `fromText` from `ogc-cql2/parse` for text).
- **Validate each request** against the same list and the collection's queryables, and answer a refusal with HTTP 400
  and the problems.

## A worked example: demo-server

The repository's `demo-server/` is a small query API (Express) over six kinds of store: a GeoJSON file
(`evaluate`), a GeoPackage (`sqlite`), a GeoParquet file (`duckdb`), PostgreSQL (`postgres`), Oracle (`oracle`) and
SQL Server (`sqlserver`). Each store declares
the classes its engine reports (`evaluateConformance({ spatialEngine })`, `sqlConformance` with the dialect's
options, without the spatial classes when DuckDB's extension didn't load), and lists them with the collection; every
request is validated against them and the collection's queryables before it is evaluated. The kitchen sink, every
type and edge case in one table, gives the same features from all of them (Oracle and SQL Server where their
documented rules apply: Oracle's `''` is NULL, and stored text is in NFC). Its code is in
`demo-server/src/` (not part of the npm package); how to run it, in the [README](../../README.md#playground-and-demo-server).
