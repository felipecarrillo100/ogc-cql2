# Developer guide

How to use ogc-cql2 in an application or a backend: one page per task. The [README](../../README.md) is the short
overview; this guide has the details.

**Start here**
- [Getting started](getting-started.md): install, the entry points, what a filter is, the conformance classes, LIKE
  patterns and missing values.

**Tasks**
- [Filtering in memory](filtering-in-memory.md): `toPredicate`, `toEvaluator` and `evaluate` on GeoJSON features or
  your own, the rules they follow, plugging in a geometry engine, and the classes `evaluate` supports
  (`evaluateConformance`).
- [Validating filters and building filter UIs](validating-and-filter-uis.md): `validate` with a server's conformance
  classes and a collection's queryables, the problems it reports, and offering only the operators an engine or a
  server supports.
- [CQL2-text](cql2-text.md): writing it with `toText` for a URL, reading it with `fromText` on a server.
- [SQL backends](sql-backends.md): `toSql` in general, the classes each dialect supports (`sqlConformance`), and
  publishing an honest `/conformance`. Then one page per database:
  - [SQLite and GeoPackage](sqlite-geopackage.md);
  - [PostgreSQL and PostGIS](postgresql.md);
  - [DuckDB](duckdb.md), in Node and in the browser, on tables and on GeoParquet files;
  - [Oracle Database](oracle.md), with Oracle Spatial;
  - [SQL Server](sqlserver.md).

**The classes in detail**
- [Spatial filters](spatial.md): geometry literals, the classes a server must declare, `s_intersects` in memory, the
  other relations with GEOS.
- [Temporal filters](temporal.md): instants, intervals and the fifteen relations.
- [Comparing two properties, and arithmetic](property-property-and-arithmetic.md).

**Reference**
- [Errors](errors.md): `Cql2Error` and its codes.
- [Versioning and stability](../../README.md#versioning-and-stability) and
  [tested versions](../../README.md#tested-versions), in the README.
- [CHANGELOG](../../CHANGELOG.md).

How the package is built and tested is in [architecture.md](../architecture.md), for contributors.
