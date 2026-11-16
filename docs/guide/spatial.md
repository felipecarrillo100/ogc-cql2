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
  LineString of one position, or a box with its south above its north. With `filter-crs`, see
  [Literals in another CRS](#literals-in-another-crs-filter-crs).
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

### The other relations: plug in an engine

The Spatial Functions class (`s_disjoint`, `s_within`, `s_touches`, …) needs a planar geometry engine, which
`evaluate` doesn't bundle; without one, it is refused (`unsupported`), and `evaluateConformance()` leaves it out. Plug one in with `spatialEngine`: it only computes DE-9IM matrices, and the package
decides what each relation means (the standard's patterns, the dimension rules of `s_overlaps` and `s_crosses`), so
engines differ only where their matrices do.

**GEOS**, the engine PostGIS, SpatiaLite and DuckDB use, and the one the package is tested against: in WebAssembly,
through [geos.js](https://www.npmjs.com/package/geos.js) (GEOS is LGPL), it takes a few lines:

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

**JSTS** ([jsts](https://www.npmjs.com/package/jsts), JTS in JavaScript, EDL-1.0 or EPL-1.0) needs no start and no
freeing, and is synchronous:

```js
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import RelateOp from "jsts/org/locationtech/jts/operation/relate/RelateOp.js";

const reader = new GeoJSONReader();
const jsts = {
  prepare(literal) {
    const l = reader.read(literal); // once per filter
    return { relate: (geometry) => RelateOp.relate(l, reader.read(geometry)).toString() };
  },
};
features.filter(toPredicate(inArea, { spatialEngine: jsts }));
```

- **Use `RelateOp.relate`,** not a geometry's own `relate` (which `monkey.js` adds): that one refuses
  GeometryCollections.
- **Measured with jsts 2.12.1 against GEOS 3.14:**
  - the standard's Table 14: 26 of 26 right;
  - on the US states, 5,805 generated literals × the six relations it decides: the same answers as GEOS;
  - the matrices are identical for points, lines, polygons and boxes;
  - for GeometryCollection literals, 47 of 5,151 differ (a member on a boundary), though no answer changed there;
  - 5 to 6 times slower than geos.js.
- **When the answers must match PostGIS exactly,** prefer GEOS: it is the databases' own engine.


## In SQL

The dialects give the same answers as `evaluate`, each in its own way: see the spatial sections of
[SQLite and GeoPackage](sqlite-geopackage.md#spatial-filters), [PostgreSQL and PostGIS](postgresql.md),
[DuckDB](duckdb.md), [Oracle Database](oracle.md) (every relation, with a tolerance of 1e-10) and
[SQL Server](sqlserver.md) (S_INTERSECTS only; points within rounding of a boundary may be decided either way). A literal first, and two geometry columns, are in
[Comparing two properties](property-property-and-arithmetic.md#comparing-two-properties).

## Literals in another CRS (`filter-crs`)

OGC API Features Part 3 lets a client name the CRS of a filter's geometries with `filter-crs` (Requirement 8), for
example a box drawn on a Web Mercator map, in metres. CQL2 leaves the CRS to the API; without `filter-crs` it is
CRS84.

**Read the filter:** `validate` and `fromText` take `crs84: false`. The literals' numbers are then not checked
against CRS84's ranges, nor a box's axis order. Everything else is checked as usual: the grammar, the profile, 2 or 3
numbers a position, rings closed, a box of 4 or 6 numbers.

```js
import { fromText } from "ogc-cql2/parse";

const CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
const crs = req.query["filter-crs"] ?? CRS84;
const filter = fromText(req.query.filter, { queryables, conformance, crs84: crs === CRS84 });
```

**Then either:**
- **Convert the literals to CRS84 yourself** (with PROJ, proj4js or your database), then use any part as usual:
  `evaluate`, `toText` and `toSql` check CRS84 and refuse a literal that wasn't converted.
- **Or give `toSql` their CRS:** `literals: { srid, yx }`.

  ```js
  toSql(filter, { dialect: "postgres", columns, literals: { srid: 3857 } });             // EPSG:3857
  toSql(filter, { dialect: "postgres", columns, literals: { srid: 4326, yx: true } });   // EPSG:4326, latitude first
  ```

  - **`srid`:** the SRID your database knows the CRS by. Map the `filter-crs` URI to it (`…/EPSG/0/3857` is 3857).
  - **`yx`:** the CRS's first axis is latitude or northing, as in EPSG:4326 as EPSG defines it, and many national
    grids. The package swaps the axes, which works on every dialect.
  - **Another SRID than 4326:** the database reprojects each literal to 4326, so only where `sqlReprojects(options)`
    is true (PostgreSQL with PostGIS: [how](postgresql.md#literals-in-another-crs)). Elsewhere it is `unsupported`.
    Ask `sqlReprojects` rather than naming dialects, as for `sqlConformance`.
  - **A box running backwards** (its minimum above its maximum) is refused outside 4326: only a geographic CRS
    crosses the antimeridian, and the package knows that only for 4326.

**What to know, whoever converts:**
- **The comparison stays planar in CRS84,** as CQL2's is: each vertex is converted, not the edges between them.
  - In a projection like UTM, a box's edges aren't straight in CRS84: it becomes a four-cornered polygon.
  - Converting moves numbers by the last digit: a Web Mercator box drawn on 51° N comes back as
    50.999999999999986, so a point exactly on 51° N falls outside it.
- **Coordinates outside the CRS's area of use are the server's to refuse** (with a 400), since neither the package
  nor the database can know each CRS's area:
  - PostGIS wraps an EPSG:3857 x past ±20,037,508.34 m to the other side of the antimeridian, silently, so a box
    drawn over it covers the world the other way;
  - with PROJ 7 (PostGIS images up to 3.5), a point far outside a UTM zone becomes `Infinity` instead of an error.
  - Check each literal against the area of use EPSG publishes for the CRSs you offer.
- **The one silent mistake:** a filter in EPSG:4326 (latitude first) read as CRS84, with no conversion. Its numbers
  may fit CRS84's ranges (any place within 90° of Greenwich), and nothing refuses it.
- **Offer only what you support,** and refuse any other `filter-crs` with a 400 (Requirement 8 C).
