# DuckDB

[Developer guide](index.md) › [SQL backends](sql-backends.md) › DuckDB

The `duckdb` dialect runs on DuckDB tables and straight on files, GeoParquet among them, with `$1`, `$2` …
placeholders. **The same SQL works in Node (`@duckdb/node-api`) and in the browser (`@duckdb/duckdb-wasm`)**, so a web
page can filter a large file locally with the filters it sends to servers.

```js
import { duckdbFunctions, duckdbValue, toSql } from "ogc-cql2/sql";

const columns = {
  name: { type: "string", sqlType: "VARCHAR" },
  opened: { type: "string", format: "date-time", sqlType: "TIMESTAMP WITH TIME ZONE" },
};
const { where, params } = toSql(filter, { dialect: "duckdb", columns });
const select = Object.entries(columns).map(([name, c]) => `${duckdbValue(name, c)} AS "${name}"`).join(", ");
const sql = `SELECT ${select} FROM 'places.parquet' WHERE ${where}`;
```

Register `duckdbFunctions` on the connection first (CASEI, ACCENTI, and dates or instants held in text, use them).
DuckDB's own `strip_accents` isn't used for ACCENTI: it also strips the spacing vowel signs of Indic scripts and the
Japanese voicing marks (548 code points differ from the standard's rule, measured). In Node:

```js
import { DuckDBInstance, DuckDBScalarFunction, INTEGER, VARCHAR } from "@duckdb/node-api";

const connection = await (await DuckDBInstance.create()).connect();
const types = { VARCHAR, INTEGER };
for (const [name, f] of Object.entries(duckdbFunctions)) {
  connection.registerScalarFunction(DuckDBScalarFunction.create({
    name,
    returnType: types[f.returns],
    parameterTypes: f.parameters.map((t) => types[t]),
    mainFunction: (info, input, output) => {
      const args = f.parameters.map((_, i) => input.getColumnVector(i));
      for (let row = 0; row < input.rowCount; row++) output.setItem(row, f.call(...args.map((a) => a.getItem(row))));
      output.flush();
    },
  }));
}
const rows = (await connection.runAndReadAll(sql, params)).getRowObjects();
```

In the browser, DuckDB-WASM registers JavaScript functions only in its synchronous ("blocking") build, which belongs
in a Web Worker. That build isn't listed in its package's `exports`, so give it an alias; with Vite:

```js
// vite.config.js
import { fileURLToPath } from "node:url";
export default {
  resolve: {
    alias: {
      "duckdb-wasm-blocking": fileURLToPath(
        new URL("./node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking.mjs", import.meta.url),
      ),
    },
  },
  worker: { format: "es" },
};
```

```js
// worker.js, started with new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
import * as duckdb from "duckdb-wasm-blocking";
import * as arrow from "apache-arrow";
import mvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import { duckdbFunctions, toSql } from "ogc-cql2/sql";

// No top-level await: Vite's default browser targets refuse it.
async function open() {
  const bundles = { mvp: { mainModule: mvp, mainWorker: "" }, eh: { mainModule: eh, mainWorker: "" } };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.BROWSER_RUNTIME);
  await db.instantiate();
  db.open({});
  const connection = db.connect();
  for (const [name, f] of Object.entries(duckdbFunctions)) {
    connection.createScalarFunction(name, new arrow.Int32(), (...args) => f.call(...args));
  }
  return { db, connection };
}

open().then(({ db, connection }) => {
  db.registerFileURL("places.parquet", url, duckdb.DuckDBDataProtocol.HTTP, false); // read by byte ranges
  const rows = connection.prepare(sql).query(...params).toArray().map((row) => row.toJSON());
});
```

- **`sqlType`** is the column's type as `DESCRIBE` gives it.
- **Text compares in code point order** (`COLLATE "binary"`) after NFC normalization, whatever the database's
  `default_collation`.
- **Instants compare as epoch milliseconds,** so the time-zone setting changes nothing.
- **`duckdbFunctions` all return 32-bit integers:** DuckDB-WASM (1.32.0) returns text, DOUBLE and BIGINT results of a
  JavaScript function wrongly, so the functions avoid them, and work the same in both runtimes.
- **Numbers are parameters as text** (`"0.9653517007827759"`, cast to DOUBLE in the SQL): DuckDB-WASM (1.32.0) binds
  about one number in ten that needs all 17 digits one unit off (`0.965351700782776`), and reads text exactly. It
  reads a SQL literal of 17 digits one unit off too, so insert such values as text (`'0.9653517007827759'::DOUBLE`).
  Instants (epoch milliseconds) are parameters as text too, since 1.3.0: `@duckdb/node-api` 1.4 binds a JavaScript
  number as a 32-bit integer, which wrapped them.
- **Spatial filters need the spatial extension** (`INSTALL spatial; LOAD spatial`, in Node and in DuckDB-WASM): give
  the geometry column as `{ sqlType: "GEOMETRY", column: "geom" }`, or a column of WKB as `{ sqlType: "BLOB" }`.
  `s_intersects` becomes `ST_Intersects(geom, literal)`, as DuckDB documents it: exact (the same answers as `evaluate`
  for thousands of literals on vertices and edges), it uses an R-tree index when the table has one, and DuckDB 2.0
  skips row groups by their statistics for it. A box across the antimeridian is one literal, so the index still
  applies. WKB is read with `TRY(ST_GeomFromWKB(…))`: bytes that aren't WKB are NULL, instead of failing the query. No
  JavaScript function stands in without the extension: DuckDB-WASM hands a BLOB to one as text, losing its bytes.
- **GeoParquet's bbox covering** (GeoParquet 1.1): give it as the file's `geo` metadata has it, and the filter compares
  its four fields first, then decides with `ST_Intersects`, as Overture's documentation writes it. That skips row
  groups, and most rows, before the exact test; DuckDB doesn't use a covering by itself. On a 730 MB Overture places
  file read over HTTP with DuckDB 2.0: 1.9 s instead of 18.7 s.

  ```js
  const [[geo]] = (await connection.runAndReadAll(
    "SELECT decode(value) FROM parquet_kv_metadata('places.parquet') WHERE decode(key) = 'geo'")).getRows();
  const { covering } = JSON.parse(geo).columns.geometry; // { bbox: { xmin: ["bbox", "xmin"], … } }, or undefined
  const columns = { geometry: { sqlType: "GEOMETRY", column: "geometry", covering } };
  ```

  The comparisons are used only where the filter isn't negated: negate the filter (`{ op: "not" }`), never the SQL it
  gives (`NOT (…)`). Leave `covering` out for a table with an R-tree index on the geometry: the index is faster on its
  own. DuckDB 1.4 and 1.5 (also in DuckDB-WASM) answer such a query exactly; DuckDB 2.0 fails on it with an internal
  error.
- **The other relations (Spatial Functions):** `ST_Equals`, `ST_Touches`, `ST_Within`, `ST_Overlaps`, `ST_Crosses`,
  `ST_Contains` (exact in DuckDB 1.4, 1.5 and 2.0, each using an R-tree index), with the covering's comparisons first
  as for `s_intersects`; `s_disjoint` as the negation of `s_intersects`.
- **Fast without a covering:** an R-tree index (`CREATE INDEX … USING RTREE (geom)`), or rows sorted spatially
  (`ORDER BY ST_Hilbert(geom, …)`) in moderate row groups, as GeoParquet's guidance recommends. On unsorted data
  without an index, `ST_Intersects` tests every row.
- **`duckdbValue(column)`** is what to SELECT for each column, as `postgresValue` is for PostgreSQL. A GeoParquet
  geometry is read with `geom::BLOB`, which is WKB.
- **Tested in both runtimes:** 24,661 generated filters on a table of awkward values, and 5,705 spatial literals on the
  US states, select the same rows as `evaluate` in DuckDB (Node) and in DuckDB-WASM (Chrome), also with a `nocase`
  default collation and another time zone. Tested with `@duckdb/node-api` 2.0.0 and `@duckdb/duckdb-wasm` 1.32.0; the
  spatial tests also run, in Node, on DuckDB 1.4.3, the engine DuckDB-WASM 1.32.0 ships.
- **The classes:** every class the package implements (`sqlConformance({ dialect: "duckdb" })`); the spatial ones
  need the spatial extension loaded.

More on the spatial rules: [Spatial filters](spatial.md).
