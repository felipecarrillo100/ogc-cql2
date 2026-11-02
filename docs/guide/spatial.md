# Spatial filters

[Developer guide](index.md) › Spatial filters

## Literals and classes

A spatial filter is a geometry property, then a geometry literal: a GeoJSON geometry, or a box.

```js
import { toText } from "ogc-cql2/text";
import { requiredConformance } from "ogc-cql2/validate";

// The map view, as a box: [west, south, east, north] in longitude / latitude.
const inView = { op: "s_intersects", args: [{ property: "geometry" }, { bbox: [5.9, 45.8, 10.5, 47.8] }] };
toText(inView); // "S_INTERSECTS(geometry, BBOX(5.9, 45.8, 10.5, 47.8))"

// A drawn area, as a polygon.
const inArea = { op: "s_within", args: [{ property: "geometry" }, {
  type: "Polygon", coordinates: [[[-80, 40], [-70, 40], [-70, 47], [-80, 47], [-80, 40]]],
}] };
requiredConformance(inArea); // the URIs of Basic CQL2 and Spatial Functions
```

- **The class a server must declare** follows the standard: `s_intersects` with a point or a box is Basic Spatial
  Functions; with any other geometry, Basic plus; any other relation, Spatial Functions. Check it against what a
  server declares with `validate`'s `conformance`.
- **Coordinates are CRS84**, longitude then latitude, as the standard says without `filter-crs`: a longitude outside
  −180…180 or a latitude outside −90…90 is refused (`invalid-geometry`). So is a ring that isn't closed, a
  LineString of one position, or a box with its south above its north.
- **A box across the antimeridian** has its west greater than its east: `[170, -10, -170, 10]`.
- **Heights** are kept: a position of three numbers, a box of six (`[west, south, min, east, north, max]`).
- **With queryables**, the property must be a geometry (`"format": "geometry-…"`, or a `$ref` to a GeoJSON schema).
- **A geometry literal first** (`S_WITHIN(BBOX(7,50,8,51), geom)`) also needs Property-Property Comparisons, since
  the standard lets a server without that class refuse it (see
  [Comparing two properties](property-property-and-arithmetic.md#comparing-two-properties)).
- **Not accepted:** a geometry's own GeoJSON `bbox` member (CQL2's schema refuses it), functions such as `Buffer`.

## In memory

`evaluate` tests `s_intersects` on each feature's `geometry`, as GeoJSON keeps it:

```js
import { toPredicate } from "ogc-cql2/evaluate";

const inView = toPredicate({ op: "s_intersects", args: [{ property: "geometry" }, { bbox: [5, 45, 15, 51] }] });
features.filter(inView); // the features the box touches
```

- **The same answers as GEOS** (PostGIS, SpatiaLite, DuckDB): planar, in the coordinates as given, boundaries
  included (a point on an edge intersects), decided with exact arithmetic. Heights are ignored. A feature without a
  geometry is NULL.
- **`geometryProperty`** (default `"geometry"`) names the property that means `feature.geometry`; any other property
  in a spatial filter is read with `getProperty` and must hold a GeoJSON geometry.
- **Tested** with the standard's own Natural Earth test (Table 12: 8, 10, 1, 3, 5, 10, 7, 4 features), and against
  GEOS on the US states for thousands of generated literals placed exactly on their vertices and edges.

### The other relations: plug in GEOS

The Spatial Functions class (`s_disjoint`, `s_within`, `s_touches`, …) needs a planar geometry engine, which
`evaluate` doesn't bundle; without one, it is refused (`unsupported`), and `evaluateConformance()` leaves it out. Plug one in with `spatialEngine`: it only computes DE-9IM matrices, and the package
decides what each relation means (the standard's patterns, the dimension rules of `s_overlaps` and `s_crosses`), so
every engine gives the same answers. GEOS in WebAssembly, through [geos.js](https://www.npmjs.com/package/geos.js)
(GEOS is LGPL), takes a few lines:

```js
import { fromGeoJSON, initializeFromBase64, prepare, relate } from "geos.js";

await initializeFromBase64(); // once, before the first filter
const geos = {
  prepare(literal) {
    const prepared = prepare(fromGeoJSON(literal)); // once per filter
    return {
      relate(geometry) {
        const g = fromGeoJSON(geometry);
        try { return relate(prepared, g); } finally { g.free(); }
      },
    };
  },
};
features.filter(toPredicate(inArea, { spatialEngine: geos }));
```

- **The engine never sees** NULLs, values that aren't a geometry, or empty geometries; a box comes as a polygon
  (across the antimeridian, a multipolygon). An engine that throws for a feature (an invalid polygon) makes that
  feature NULL.
- **`s_intersects` and `s_disjoint`** keep the package's own exact engine when one is plugged in. Without one,
  `s_disjoint` is refused (`unsupported`) with the rest of Spatial Functions, the class the standard puts it in.
- **Tested** with the standard's own Natural Earth test for Spatial Functions (Table 14: all 26 predicates and their
  counts), and against PostGIS on the US states for every relation.


## In SQL

The three dialects give the same answers as `evaluate`, each in its own way: see the spatial sections of
[SQLite and GeoPackage](sqlite-geopackage.md#spatial-filters), [PostgreSQL and PostGIS](postgresql.md) and
[DuckDB](duckdb.md). A literal first, and two geometry columns, are in
[Comparing two properties](property-property-and-arithmetic.md#comparing-two-properties).
