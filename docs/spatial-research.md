# Research: CQL2's spatial operations

**Status: research only, 2026-10-31.** Nothing here is implemented. It records what CQL2 1.0.0 defines for
geometries, so that spatial support can be planned from it. Sources: CQL2 1.0.0 (OGC 21-065r2) and its released
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
| `sql`, `sqlite` | SQLite and GeoPackage have no spatial functions without SpatiaLite; registered functions of our own again (as for CASEI), sharing the in-memory engine, or none |
| an application's FES output (WFS) | FES 2.0 has the same eight operators, plus `BBOX`, `DWithin` and `Beyond` |
| testing | the standard's spatial examples (`test/fixtures/ogc/`, already present, now refused as `outside-profile`); the differential test across the three stores, extended with the kitchen sink's geometries |

A sensible order, if it is taken up: Basic Spatial Functions first (`S_INTERSECTS` with points and boxes: small,
no engine needed, and what most map clients ask for); then the additional literals; then the full Spatial Functions
class once the engine question is settled.
