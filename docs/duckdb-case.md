# The case for a DuckDB dialect

**Status: accepted, 2026-10-31; the dialect is in 0.2.0.** This document argued for adding DuckDB to
`ogc-cql2/sql` and listed what to verify first. The spike's answers are at the end, under "What the spike found".

## In one paragraph

More and more geodata is published as **files**, above all GeoParquet, rather than loaded into databases.
**DuckDB** is the embedded database that queries such files where they lie, on disk or in cloud storage, fast, and
also **inside the browser** (DuckDB-WASM). A `duckdb` dialect would let the same CQL2 filter that a client sends to an
OGC API Features server also filter a GeoParquet file: in a Node server, with no database to run, or in a web page,
with no server at all. It is the cheapest dialect to add, and it opens a use the existing dialects can't cover.

## The problem it solves

| Today | Limitation |
|---|---|
| A GeoJSON file (`evaluate`, in memory) | the whole file is read into memory; fine for thousands of features, not millions |
| SQLite / GeoPackage | the data must first be converted into a GeoPackage |
| PostgreSQL / PostGIS | the data must be imported into a database server someone runs and maintains |

A publisher with a large GeoParquet file (or a folder of them, or a URL in cloud storage) has no way today to serve
it as a filterable collection without an import step. A web client has no way to filter a large file locally with the
same filters it sends to servers.

## What DuckDB offers

- **Embedded, like SQLite:** a library, no server. Nothing to install, administer or secure.
- **Reads files in place:** GeoParquet, Parquet, CSV, GeoJSON, and (through its spatial extension and GDAL) GeoPackage
  and other formats; locally, or over HTTP and from object storage (S3, Azure) with its HTTP extension.
- **Fast on large data:** columnar and vectorized; it filters millions of rows quickly and handles data larger than
  memory. That is the typical OGC API Features query: a few thousand features out of millions.
- **In the browser:** DuckDB-WASM runs the same engine in a web page.
- **Spatial built on GEOS and PROJ:** the full DE-9IM relations (`ST_Intersects`, `ST_Within`, …) and reprojection,
  so all eight CQL2 spatial functions could be exact later (see [spatial-research.md](spatial-research.md)), unlike
  stores without a geometry engine.

## Who gains

| User | Gain |
|---|---|
| **A data publisher** | large GeoParquet / Parquet files served as OGC API collections, without a database server or an import step |
| **A server builder** | a fast, zero-administration backend for read-mostly geodata, local or in the cloud, next to the existing GeoJSON, GeoPackage and PostgreSQL stores |
| **A web map client** | large local or remote files filtered **in the browser**, with the same CQL2 filters, and the same filter UI, as server-side layers. Possible because `ogc-cql2/sql` only builds strings and has no dependencies |

## Evidence

- **Adoption:** 3.3% of developers use DuckDB (Stack Overflow Developer Survey 2025): small, but a recent and
  fast-growing tool, strongest in data engineering and analysis, the people who prepare and publish geodata.
- **Geodata is moving to GeoParquet:** large open datasets are published in it (Overture Maps among the best known),
  and GeoParquet is developed in OGC's GeoParquet Standards Working Group. DuckDB is one of the usual tools for
  reading it.
- **Fit with this package:** DuckDB's SQL is close to PostgreSQL's; its default string comparison is binary (code
  point order), though a database's `default_collation` can change it; it has `nfc_normalize()`; LIKE is
  case-sensitive with an `ESCAPE` clause. Most of the `postgres` dialect's rules carry over.

## Cost

Low, compared with the other candidates (see the roadmap in [architecture.md](architecture.md)). As estimated, and as
it turned out:

| Part | Estimated | As built (0.2.0) |
|---|---|---|
| the dialect | small: close to `postgres`, on the dialect interface it pays for | as estimated: `src/sql/dialects/duckdb.ts`, on the interface that SQLite and PostgreSQL moved onto unchanged |
| CASEI | a JavaScript function (as for SQLite), or an SQL macro (as for PostgreSQL) | JavaScript functions returning integers (`cql2_casei_cmp`, `cql2_casei_like`): DuckDB-WASM can't return text from a function, and a macro can't be exact, since DuckDB has no NFD |
| tests | no server, no Docker: DuckDB in the test process | as estimated: 11,050 generated filters against `evaluate`, also under a `nocase` default collation and another time zone |
| a DuckDB store in `demo-server` | small; GeoParquet files listed in `collections.json` | in progress |
| DuckDB-WASM in the playground | not estimated | in progress |

The package itself stays dependency-free: the DuckDB driver belongs to the application (a server, or a web page
loading DuckDB-WASM), as `node:sqlite` and `pg` do today.

## Risks, and how they turned out

| Risk | Outcome |
|---|---|
| Registering JavaScript functions may differ between DuckDB's Node and browser builds | **It did.** DuckDB-WASM registers them only in its synchronous build, and passes back only 32-bit integers exactly. The functions were designed around that, so one set works in both |
| The spatial extension's availability in DuckDB-WASM | available: it loads in the browser (see below) |
| DuckDB evolves fast | **The two runtimes carry different engines:** DuckDB-WASM 1.32.0 is DuckDB 1.4.3, `@duckdb/node-api` 2.0.0 is DuckDB 2.0. The dialect only emits SQL, but the Node test doesn't prove the browser: DuckDB-WASM gets its own check in the playground |
| Single writer: DuckDB is not a shared, transactional database | unchanged: out of scope by design, for read-mostly publishing; editing stays with PostgreSQL |
| A smaller audience than MySQL or SQL Server | unchanged: offset by the low cost and the browser use, which no other dialect offers |

## Recommendation, and the decision

The recommendation was to add DuckDB as the first new dialect, the one that pays for the dialect interface: the
cheapest and lowest-risk way to prove the refactor, with no test server, opening two uses no current dialect covers
(large files served without a database, and filtering in the browser), after a spike to measure the open points.

**Decided on 2026-10-31,** with the browser, and mobile devices in particular, as the main draw: one `duckdb`
dialect, the same SQL in Node and in the browser, in **0.2.0** rather than 1.x.x. Oracle and SQL Server follow in
1.x.x on the same interface. DuckDB's spatial extension is left for the spatial classes.

## What the spike found

Measured on 2026-10-31 with `@duckdb/node-api` 2.0.0 (DuckDB 2.0) and `@duckdb/duckdb-wasm` 1.32.0 (DuckDB 1.4.3) in
Chrome, on a GeoParquet file of a million points.

| Question | Answer |
|---|---|
| Text, LIKE, parameters | the same in both runtimes: code point order, `nfc_normalize()`, case-sensitive `LIKE … ESCAPE '\'`, `_` one code point, `$1` placeholders. A pattern ending in a lone `\` is an error, as in PostgreSQL. A database's `default_collation` (`nocase`) does change `=` and `IN`, so the dialect sets `COLLATE "binary"` |
| JavaScript functions | Node: `registerScalarFunction`. WASM: `createScalarFunction`, only in the synchronous ("blocking") build, which isn't in the package's `exports`; it runs in a Web Worker. **Only 32-bit integer results come back exactly from WASM:** text as zero bytes, DOUBLE as a 32-bit float, BIGINT cut to 32 bits, BOOLEAN refused (also in 1.33.1-dev110). So every function returns an integer, the same in both runtimes |
| Instants | `epoch_ms` rounds to the nearest millisecond, where `evaluate` truncates: the dialect uses `floor(epoch_us(…) / 1000)` |
| GeoParquet | reads without the spatial extension; the geometry is `GEOMETRY` in DuckDB 2.0, `BLOB` in 1.4.3; `geom::BLOB` is WKB in both |
| Spatial extension in WASM | loads (about 1.4 s, from DuckDB's extension site), and `ST_Point` works. For the later spatial classes |
| Speed, a million points | a plain filter: 5 ms in Node; in Chrome 34 ms, or 194 ms the first time, reading only the byte ranges it needs. The same data as GeoJSON is 188 MB to download and parse (about 1 s), against 36.8 MB of Parquet. CASEI calls JavaScript for each row: 1–2 s per million rows in both |
| Mobile | runs in Chrome's phone emulation; its CPU throttling doesn't reach Web Workers, so speed on a phone needs a real phone |
