# Research: CQL2's spatial operations

**Status: research and decisions, 2026-10-31.** Nothing here is implemented yet. It records what CQL2 1.0.0 defines
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
| **DuckDB** + spatial extension | all eight (no `ST_Relate`) | an R-tree index for tables (`CREATE INDEX … USING RTREE`); not seen in `EXPLAIN` in a first test | a point on a boundary intersects; the extension also loads in DuckDB-WASM (about 1.4 s). It writes GeoParquet 1.0 metadata (one bbox per file), not the per-row bbox column of GeoParquet 1.1 |

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

