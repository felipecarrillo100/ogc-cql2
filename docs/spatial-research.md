# Research: CQL2's spatial operations

**Status: research and decisions, 2026-10-31; phase A implemented in 0.6.0** (the types, `validate` and `text` for
the three classes), **phase B in 0.7.0** (`evaluate`, S_INTERSECTS), **phase C in 0.8.0** (PostGIS), **phase D in 0.9.0** (SQLite / GeoPackage, DuckDB), **Spatial Functions in
0.10.0** (every engine). It records what CQL2 1.0.0 defines
for geometries, what the candidate engines do (measured), and the design decided from it (at the end, "Engines,
measured" and "Decisions"). Sources: CQL2 1.0.0 (OGC 21-065r2) and its released
grammar (`cql2.bnf`, tag `cql2-1.0.0` of github.com/opengeospatial/ogcapi-features), and OGC API - Features - Part 3:
Filtering (OGC 19-079r2) for the coordinate reference system.

## The three spatial conformance classes

| Class (`http://www.opengis.net/spec/cql2/1.0/conf/…`) | Functions | Geometry literals |
|---|---|---|
| **Basic Spatial Functions** (`basic-spatial-functions`) | `S_INTERSECTS` only | `POINT` and `BBOX` only (Permission 7) |
| **Basic Spatial Functions with additional Spatial Literals** (`basic-spatial-functions-plus`) | `S_INTERSECTS` only | all of them: points, lines, polygons, the multi-types, collections, `BBOX` |
| **Spatial Functions** (`spatial-functions`) | all eight below | all of them |

A server declares the classes it implements; a client offers only what the server declares, as `ogc-cql2/validate`
already does for the comparison classes (`options.conformance`, `needs-conformance`).

## The eight spatial comparison functions

They are evaluated "as defined in clause 6.1.15 of OGC Simple Feature Access - Part 1" (ISO 19125), with a Boolean
result (Requirement 11 B), and defined with the DE-9IM intersection model (the standard's Table 4 gives each matrix):

| Function | `S_X(a, b)` is TRUE when | Notes |
|---|---|---|
| `S_INTERSECTS` | a and b share at least one point | the only one in the basic classes |
| `S_DISJOINT` | they share no point | exactly `NOT S_INTERSECTS`: the "excludes" relation |
| `S_CONTAINS` | b lies inside a | `S_CONTAINS(a, b)` ⇔ `S_WITHIN(b, a)` |
| `S_WITHIN` | a lies inside b (a ∩ b = a, and no part of a's interior is outside b) | |
| `S_EQUALS` | they are the same set of points | the vertex order doesn't matter |
| `S_TOUCHES` | they meet only at boundaries; the interiors don't meet | |
| `S_OVERLAPS` | they have the same dimension, share part of their interiors, and neither contains the other | two areas, or two lines |
| `S_CROSSES` | their interiors meet in a lower dimension, and neither contains the other | a line crossing a polygon or another line |

## Geometry literals

- **CQL2-text:** OGC Well-Known Text, with an optional `Z`: `POINT`, `LINESTRING`, `POLYGON` (outer ring, then holes),
  `MULTIPOINT`, `MULTILINESTRING`, `MULTIPOLYGON`, `GEOMETRYCOLLECTION`; and `BBOX(west, south, east, north)`, or
  six numbers with a vertical range (`BBOX(west, south, min, east, north, max)`).
- **CQL2-JSON:** a GeoJSON geometry object (RFC 7946), or `{ "bbox": [4 or 6 numbers] }`.
- **A bbox across the antimeridian** has its west value larger than its east value.
- Examples (the standard's own):
  - `S_INTERSECTS(geometry, POINT(36.319836 32.288087))`;
  - the same in CQL2-JSON: `{ "op": "s_intersects", "args": [{ "property": "geometry" },
    { "type": "Point", "coordinates": [36.319836, 32.288087] }] }`;
  - `S_CROSSES(road, POLYGON((…)))`.

## The rules around them

- **NULL:** if either geometry expression is NULL, the predicate is NULL (Requirement 10 C): the same three-valued
  logic as every other predicate.
- **Operand order:** a server MAY refuse a literal as the first operand, and a property as the second
  (Permission 6). Comparing two geometry properties needs the Property-Property Comparisons class, as for the
  comparison operators. The portable form is `S_X(property, literal)`, which is what the profile would accept.
- **Coordinate reference system:** WKT and GeoJSON can't name a CRS, so CQL2 leaves it to the protocol. In OGC API
  Features Part 3:
  - without the `filter-crs` parameter, the server reads the filter's geometries as **CRS84** (longitude, latitude),
    or **CRS84h** with a height (Requirement 7, `/req/filter/filter-crs-wgs84`);
  - with `filter-crs`, they're in that CRS; a server that doesn't support it answers with an error (Requirement 8).
- **Invalid coordinates must be refused:** the conformance tests expect `POINT(90 180)` (a latitude of 180) to fail.

## "Within a distance": not in CQL2 1.0

The grammar says it outright, next to `spatialFunction`:

> NOTE: The buffer functions (DWITHIN and BEYOND) are not included because these are outside the scope of a "simple"
> core for CQL2. These can be added as extensions.

Three ways to get it anyway:

1. **A custom function** (CQL2's Functions class): a server can offer, say, `DWITHIN(geometry, POINT(…), 500)` and
   list it in its `/functions` resource (OGC API Part 3). Only for servers that declare it; the name and the
   parameters aren't standardized.
2. **A buffer computed by the client, then `S_INTERSECTS`**: "500 m around this point" as a polygon. It works on any
   server with additional spatial literals, but it is an approximation (a polygon for a circle), and distances in
   degrees need care.
3. **Outside CQL2:** OGC Filter Encoding 2.0 (used by WFS) defines `DWithin` and `Beyond`, with a distance and a unit;
   GeoServer's ECQL has `DWITHIN`; PostGIS has `ST_DWithin`.

## What spatial support would mean for this package

| Part | It would need |
|---|---|
| types / `validate` | the three classes; GeoJSON geometries and `bbox` as literals; coordinate checks (longitude −180…180, latitude −90…90 in CRS84), rings closed, the operand-order rules |
| `text` | WKT written exactly per the BNF (`POINT Z (…)`, `BBOX(…)`) |
| `evaluate` (in memory) | a real DE-9IM engine. **The big piece:** either a dependency such as JSTS, which would end "no dependencies", or an implementation of our own, which is large. Only `S_INTERSECTS` with a point or a box (the Basic class) is small enough without one |
| `sql`, `postgres` | PostGIS: `ST_Intersects`, `ST_Disjoint`, `ST_Contains`, `ST_Within`, `ST_Equals`, `ST_Touches`, `ST_Overlaps`, `ST_Crosses` map one to one, same DE-9IM semantics; literals via `ST_GeomFromGeoJSON`, in CRS84 unless `filter-crs` says otherwise, with `ST_Transform` to the column's SRID |
| `sql`, `duckdb` | DuckDB's spatial extension (GEOS-based): the same eight `ST_*` functions, DE-9IM semantics, on GeoParquet geometries. It loads in DuckDB-WASM too (about 1.4 s, measured 2026-10-31), so a page could filter spatially in the browser; it is an extension the application installs, not part of core DuckDB |
| `sql`, `sqlite` | SQLite and GeoPackage have no spatial functions without SpatiaLite; registered functions of our own again (as for CASEI), sharing the in-memory engine, or none |
| an application's FES output (WFS) | FES 2.0 has the same eight operators, plus `BBOX`, `DWithin` and `Beyond` |
| testing | the standard's spatial examples (`test/fixtures/ogc/`, already present, now refused as `outside-profile`); the differential test across the three stores, extended with the kitchen sink's geometries |

A sensible order, if it is taken up: Basic Spatial Functions first (`S_INTERSECTS` with points and boxes: small,
no engine needed, and what most map clients ask for); then the additional literals; then the full Spatial Functions
class once the engine question is settled.

## Engines, measured

Measured on 2026-10-31 with PostgreSQL 17.10 + PostGIS 3.5.6 (GEOS 3.13.1), SQLite 3.51.3 (Node's `node:sqlite`) with
SpatiaLite 5.1.0 (GEOS 3.15.0), and DuckDB 2.0 with its spatial extension (`@duckdb/node-api`).

| Engine | Spatial relations | Spatial index | Notes |
|---|---|---|---|
| **PostGIS** | all eight (`ST_Intersects` … `ST_Crosses`, plus `ST_Relate`) | GiST, used automatically | a point on a boundary intersects (and touches) |
| **SQLite / GeoPackage**, plain | none | the GeoPackage R-tree extension (`gpkg_rtree_index`: tables `rtree_<table>_<column>`); SQLite's R-tree module is built into `node:sqlite` | an R-tree gives *candidates* (bounding boxes), never the answer |
| **SQLite + SpatiaLite** | all eight, on GEOS | the same R-tree | agrees with PostGIS on the US states for every box tried, **but only on `GeomFromGPB(geom)`**: on the raw GeoPackage blob, `ST_Intersects` returns −1 ("can't compute"), which SQL reads as true, so a filter would select everything. Compare with `= 1`. One kitchen-sink geometry still gives −1 (to investigate) |
| **DuckDB** + spatial extension | all eight (no `ST_Relate`) | an R-tree index for tables (`CREATE INDEX … USING RTREE`), shown in `EXPLAIN` as `RTREE_INDEX_SCAN` (1.4) or `Rtree Index Scan` (2.0); from 1.5, statistics per row group | a point on a boundary intersects; the extension also loads in DuckDB-WASM (about 1.4 s). It writes GeoParquet 1.0 metadata (one bbox per file), not the per-row bbox column of GeoParquet 1.1 |

**Edges are planar, and that decides every engine.** CQL2 follows Simple Features, whose edges are straight lines in
the coordinates: in CRS84, straight in longitude and latitude, as in PostGIS `geometry`, SpatiaLite and DuckDB.
A geodesic edge (PostGIS `geography`, ellipsoidal geometry libraries) is a different line: along the 49th parallel
from −123° to −95°, the two are **95 km** apart at the middle. Engines with different edge models disagree on every
feature in that band, so every engine used for CQL2, including an application's own, must be planar.

**Heights (3D).** Every engine's `ST_Intersects` ignores Z (a point at 500 m "intersects" a box from 0 to 100 m).
Only PostGIS compares in 3D: `&&&` for n-dimensional boxes (index-capable with `gist_geometry_ops_nd`) and
`ST_3DIntersects` for points, lines and polygons; solids (polyhedra) need its SFCGAL extension. SpatiaLite has 3D
distance only; DuckDB has `ST_ZMin` / `ST_ZMax` (a height-range check, exact for points only).

**JavaScript libraries** (public npm, 2026-10-31):

| Library | What | Licence, size | Use here |
|---|---|---|---|
| `robust-predicates` 3.0.3 | exact orientation tests (Shewchuk) | Unlicense, no dependencies | its orientation test copied into our engine (the Unlicense permits it): what makes boundary cases agree with GEOS |
| `@turf/boolean-*` 7.4 | planar booleans on GeoJSON | MIT | an oracle in tests, not a dependency |
| `jsts` 2.12 | JTS ported: full DE-9IM | EPL / EDL, 3.6 MB | an engine an application may plug in |
| `geos-wasm` 3.1 | GEOS in WebAssembly | LGPL, 3 MB | an engine an application may plug in: the same answers as PostGIS by construction |
| `flatbush` 4.7, `rbush` 4.0 | R-tree indexes | ISC, MIT | only if `evaluate` is measured to need an index |

An application may also have a geometry engine of its own (a map SDK's topology or boolean operations): through the
hook below, without the package depending on it, provided it is planar.

## Decisions (2026-10-31)

1. **One meaning, many engines:** planar, CRS84, GEOS's answers as the reference. Each engine supports the classes it
   computes exactly, and a server declares those; a client offers only them (`validate`'s `conformance`).

   | Engine | Basic | Basic plus | Full |
   |---|---|---|---|
   | `evaluate`, built-in engine (our code and the robust orientation test) | ✅ | ✅ | — |
   | `evaluate` with an engine the application plugs in (optional hook) | ✅ | ✅ | ✅ |
   | SQLite / GeoPackage, plain (a registered function sharing `evaluate`'s engine, the R-tree as pre-filter) | ✅ | ✅ | — |
   | SQLite + SpatiaLite (optional) | ✅ | ✅ | ✅ |
   | PostGIS | ✅ | ✅ | ✅ |
   | DuckDB + spatial extension | ✅ | ✅ | ✅ |

2. **The plug-in hook is optional:** `evaluate` works without it; an engine passed in (GEOS in WebAssembly, JSTS, a
   map SDK's) adds the full class. The engine receives the whole geometry, heights included.
3. **Proof, as for the rest of the package:** PostGIS as the reference; differential tests showing every engine
   selects the same features; the standard's Natural Earth counts (Table 12: 8, 10, 1, 3, 5, 10, 7, 4) as an
   acceptance test; a test showing an index only narrows the candidates, never changes the result.
4. **Heights:** a six-number bbox and Z coordinates are accepted and kept in the filter, and compared in 2D for now,
   as every engine does; documented as a deliberate choice. A 3D mode comes later with JSON-FG (where `place`
   geometries in a 3D CRS are common): PostGIS natively (SFCGAL for solids), `evaluate` through the hook.
5. **CRS:** CRS84 only for now (the standard's default without `filter-crs`). Data stored in another CRS is the
   engine's business (PostGIS transforms its column). `filter-crs` comes with JSON-FG, for the SQL engines that can
   transform; `evaluate` would refuse it rather than guess.

Order: Basic and Basic plus first (types, `validate` and `text` for all three classes; `evaluate`; PostGIS; SQLite;
DuckDB), then Full in PostGIS, SpatiaLite, DuckDB and the hook.

## As implemented: phase A (0.6.0)

- The filter format, validation and CQL2-text for the three classes; `evaluate` and `sql` refuse spatial filters with
  `unsupported` until their phases.
- 13 of the standard's 19 spatial examples are in the profile (the property first); the other 6 put the literal first
  (Permission 6) or use a function (`Buffer`). Their CQL2-text is checked with cql2-rs against the standard's own
  text, not against its JSON: cql2-rs 0.5.6 drops Z coordinates and reads `BBOX` as a function call (measured).
- Measured on the way: CQL2's JSON Schema refuses a geometry with its own GeoJSON `bbox` member (it is then also a
  bbox literal, and the literal is a `oneOf`), so `validate` refuses it too.

## As implemented: phase B (0.7.0)

- `evaluate` tests S_INTERSECTS (the two basic classes) in memory, with our own planar engine and Shewchuk's exact
  orientation test; Spatial Functions stay `unsupported` there (they come with the optional engine hook).
- The standard's Natural Earth test (Table 12) gives all eight counts on today's Natural Earth (5.2.0-pre).
- Against GEOS on the US states, 5,705 generated literals select the same states.
- **Measured on the way, for the PostGIS dialect:** PostGIS 3.5.6's `ST_Intersects` departs from GEOS for points
  lying exactly on an edge (109 point-state pairs in the test): it answers false where `ST_Relate` puts the point on
  the boundary, and `ST_Disjoint` and `ST_Distance` agree with GEOS. Its point-in-polygon shortcut isn't exact there.
  The dialect will have to choose between `ST_Intersects` (fast, uses the index, not exact on edges) and a form that
  is exact; to be measured in that phase.
- The plain floating-point orientation test agrees with GEOS on the states (their coordinates have about seven
  significant digits), but not on near-collinear points found by search; those, checked against PostGIS, are unit
  tests.

## As implemented: phase C (0.8.0)

- The `postgres` dialect writes S_INTERSECTS as `geom && literal AND NOT ST_Disjoint(geom, literal)`, chosen by
  measurement (PostgreSQL 17, PostGIS 3.5.6, a million random points with a GiST index):

  | Form | Literals differing from `evaluate` (of 5,705) | Map-view box | Small polygon | Quarter of the world | Index |
  |---|---|---|---|---|---|
  | `ST_Intersects` | 99 | 0.8 ms | 0.4 ms | 62 ms | yes |
  | `NOT ST_Disjoint` | 0 | 121 ms | 118 ms | 146 ms | no |
  | `&&` and `NOT ST_Disjoint` | 0 | 0.6 ms | 0.4 ms | 71 ms | yes |

- **Corrected in 0.9.1:** the departure of `ST_Intersects` above is an arm64 trait, not PostGIS 3.5.6's. PostGIS's
  point-in-polygon test (`liblwgeom/intervaltree.c`) computes its side test as `a*b - c*d`, which arm64 compilers fuse
  into one multiply-add, so a point exactly on an edge can come out on one side. On amd64, PostGIS 3.1–3.6 were exact.
  PostGIS 3.7 sends `ST_Disjoint` for a point and a polygon through the same test (PR #1074), so the 0.8.0 form missed
  the same points there on arm64 (99 of 5,805 literals). 0.9.1 decides with `NOT ST_Relate(geom, literal,
  'FF*FF****')`, GEOS's full matrix: 0 differences on PostGIS 3.1–3.7, amd64 and arm64. No other CQL2 implementation
  read (GeoServer, pgstac, tipg, pygeoapi, cql2-rs) avoids the shortcut.
- A column in another SRID is transformed to 4326 (planar in CRS84). Measured on the kitchen sink in 3857: the same
  features with margin; 58 of 141 literals placed exactly on the original 4326 vertices differ, because the stored
  3857 coordinates don't convert back exactly (5 becomes 4.999999999999998). Data kept in another CRS can't be exact
  on its original vertices.


## As implemented: phase D (0.9.0)

- **SQLite / GeoPackage:** SQLite has no spatial functions, so `sqliteFunctions.cql2_intersects(geometry, literal)`
  runs `evaluate`'s own engine on the stored geometry: a GeoPackage blob (the `GP` header, then WKB) or plain WKB
  (PostGIS's extended flags understood), read by `src/sql/wkb.ts`. The header's envelope rejects most rows before the
  WKB is decoded (2–4 times faster on a million rows). GeoPackage's R-tree, given as the column's `rtree`, finds the
  candidates first (a small box: 811 ms → 3 ms), but only for a leaf outside a NOT: the R-tree holds no NULL or empty
  geometries, so it gives FALSE where `evaluate` gives NULL, which selects the same rows only there (three-valued
  logic: a condition TRUE with a NULL leaf is TRUE with FALSE, and only NOT turns FALSE into TRUE).
- **DuckDB:** the spatial extension's `ST_Intersects` is exact, unlike PostGIS's: 0 of the 5,705 literals differ from
  `evaluate`, in `@duckdb/node-api` 2.0 (with and without an R-tree index) and in DuckDB-WASM 1.32.0. The dialect writes
  it as DuckDB documents it, `ST_Intersects(g, L)` with a constant literal, as rustac and cql2-rs do: it uses an R-tree
  index on both engines (1–12 ms for a small box or polygon on a million rows, in the browser too), and on DuckDB 2.0
  the row groups' statistics. Across the antimeridian the literal is one `ST_Union` (an OR of two tests loses the index: 241 ms
  against 5 ms). A `BLOB` of WKB is read with `TRY(ST_GeomFromWKB(c))`: plain `ST_GeomFromWKB` fails the whole query
  on one bad value.
- **GeoParquet's bbox covering** (1.1), given as `SqlColumn.covering` in the file's own metadata shape: outside a NOT,
  its four fields are compared first, as Overture's documentation and Martin write it. DuckDB doesn't use a covering
  by itself (Overture places, 730 MB over HTTP: 256 of 256 row groups read and 18.7 s without the comparisons, 11 and
  1.9 s with them). Fastest form in every measurement, on both engines (5–16 ms in the browser on sorted data).
- **Measured, and not chosen:** `ST_Intersects AND ST_Intersects_Extent`, 15 times faster than `ST_Intersects` alone
  on DuckDB 2.0 without an index, is no faster on DuckDB 1.4.3, DuckDB-WASM's engine, and loses the R-tree index
  there. No one else writes it. A canary watches the gap on DuckDB 2.0.
- **No stand-in for the extension:** DuckDB-WASM hands a BLOB argument to a JavaScript function as UTF-8-decoded text
  (each byte ≥ 0x80 becomes U+FFFD), so `evaluate`'s engine can't receive WKB there. Hex text works in both
  runtimes, but costs 50% more in Node on a path already a hundred times slower than the extension, so it wasn't
  chosen: DuckDB's spatial filters need the extension, which loads in DuckDB-WASM.
- **Found on the way:** DuckDB-WASM 1.32.0 binds about one in ten JavaScript numbers that need 17 significant digits
  one unit off, which broke 23 of the 5,705 literals in the browser (box corners exactly on vertices). The `duckdb`
  dialect now binds every number as its text, which DuckDB reads exactly; this also fixes ordinary comparisons in the
  browser. And `evaluate` treats an empty Point written as `{"type": "Point", "coordinates": []}` (GDAL's form) as
  empty, so false, not NULL.
- **Tested:** `test/sql-spatial.test.ts` (132 filters, nested NOTs among them, on every SQLite storage form, with
  empty, NULL, text and unreadable values), `test/duckdb-spatial.ts` (the same filters on DuckDB 2.0 and 1.4.3, with
  and without a covering, the index's use, and canaries on what the dialect relies on in DuckDB), the 5,705 literals
  through demo-server's GeoPackage store, the four-store comparison, and the browser check; each rule broken once on
  purpose.

## As implemented: Spatial Functions (0.10.0)

- **One meaning:** `src/core/relate.ts` holds the relations as Simple Features' DE-9IM patterns.
  - It also holds the dimension rules of S_OVERLAPS and S_CROSSES, and the transposition.
  - CQL2's Table 4 gives S_TOUCHES' second matrix as `F**F*****`. Simple Features, GEOS and PostGIS use `F**T*****`.
  - S_DISJOINT is NOT S_INTERSECTS everywhere, with the same NULLs.
- **`evaluate`:** an optional `spatialEngine` that only returns matrices, so the package, not the engine, decides each
  relation.
  - Measured (geos.js 0.1.5, GEOS 3.14): the patterns reproduce GEOS's own predicates on tricky pairs (vertices,
    edges, holes, collections), and match PostGIS on the US states for all six relations × 5,805 literals.
  - JSTS fails on collections, its prepared geometries are broken, and it is slow. Turf gives wrong answers.
- **PostGIS:** Equals, Touches, Overlaps and Crosses are exact as functions. Within and Contains take PostGIS's
  point-in-polygon shortcut, so they are `ST_Relate` with the pattern, behind `@` / `~`.
  - Measured on PostGIS 3.1–3.7, amd64 and arm64, 1,527 literals × 7 relations each: 0 differences.
  - Plain `ST_Contains` was wrong for 26 literals on every arm64 server, and `ST_Disjoint` for 29 on 3.7.
- **DuckDB:** the functions themselves, exact on DuckDB 1.4.3, 1.5.4 and 2.0, and in DuckDB-WASM 1.32.0 and
  1.33.1-dev57.0. The covering's overlap test applies to every relation but S_DISJOINT.
- **SQLite:** SpatiaLite as an option.
  - SpatiaLite reads GeoPackage blobs itself; the package's own reader, as WKT, takes what it can't.
  - Empty geometries are decided by the package, since SpatiaLite can't represent one.
  - −1 ("can't compute") is NULL.
- **The standard's own test:** Table 14 (A.9.9, test 38), all 26 predicates, on Natural Earth converted at full
  precision from the shapefiles. The published GeoJSON's rounding moves the vertices that S_EQUALS and S_TOUCHES
  literals sit on.
