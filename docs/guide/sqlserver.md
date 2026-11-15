# SQL Server

[Developer guide](index.md) › [SQL backends](sql-backends.md) › SQL Server

The `sqlserver` dialect gives the same exact results on SQL Server 2022 and later, with Basic Spatial Functions on
`geometry` columns. Placeholders are named `@p1`, `@p2` …: bind `params[i]` as `p<i+1>`.

```js
import mssql from "mssql";
import { sqlserverFunctions, sqlserverValue, toSql } from "ogc-cql2/sql";

const pool = await new mssql.ConnectionPool({ server, database, user, password }).connect();
for (const batch of sqlserverFunctions()) await pool.request().batch(batch); // once: dbo.cql2_casei, cql2_like…

const columns = {
  name: { type: "string", sqlType: "nvarchar" },
  opened: { type: "string", format: "date-time", sqlType: "datetimeoffset" },
  geometry: { format: "geometry-any", sqlType: "geometry", column: "geom" },
};
const { where, params } = toSql(filter, { dialect: "sqlserver", columns });
const request = pool.request();
params.forEach((value, i) => request.input(`p${i + 1}`, value));
const select = Object.entries(columns).map(([name, c]) => `${sqlserverValue(c.column ?? name, c)} AS "${name}"`).join(", ");
const { recordset } = await request.query(`SELECT ${select} FROM dbo.places WHERE ${where}`);
```

- **`sqlType`** is the type as `sys.types` names it (`nvarchar`, `varchar`, `int`, `float`, `decimal`, `bit`, `date`,
  `datetimeoffset`, `datetime2`, `geometry`…).
- **`sqlserverFunctions(schema = "dbo")`** returns T-SQL batches, each run on its own (in a script, separated by
  `GO`). They create:
  - the package's tables, as code points: case folding, accent marks, and Unicode's decompositions, combining classes
    and compositions;
  - `cql2_casei`, `cql2_accenti`, `cql2_like`, `cql2_day`, `cql2_instant` and `cql2_arithmetic`.
  
  SQL Server calls a scalar function only by a two-part name: give `functionSchema` if they aren't in `dbo`.
- **Text compares as its UTF-8 bytes:** code point order, whatever the column's or the database's collation. It loses
  the column's index.
  - SQL Server compares `'a' = 'a '` as TRUE in every collation, and its LIKE ignores the value's trailing blanks, so
    neither is used as it is.
  - LIKE is SQL Server's when the pattern has no `_`, else `cql2_like`: SQL Server's `_` isn't one code point (on
    2022, one UTF-8 byte).
- **Numbers** compare as float. Literals are bound as text; a subnormal one is scaled, since SQL Server reads its text
  as 0.
- **Arithmetic** goes through `cql2_arithmetic`, which never raises an error. SQL Server would fail the whole query on
  an overflow, a division by zero or a power outside its domain; `evaluate` gives NULL.
- **Dates and instants:**
  - a `date` compares as a date, and keeps the index;
  - a `datetimeoffset` is an instant, as epoch milliseconds in UTC, truncated;
  - `datetime2`, `datetime` and `smalldatetime` have no zone, so they are text only;
  - text columns go through `cql2_day` and `cql2_instant`.
- **No boolean values in T-SQL:** a condition used as a value is written as 1, 0 or NULL. TRUE is `1 = 1`, and no
  value matching is `1 = NULL`, which needs ANSI_NULLS ON, the default.
- **`sqlserverValue(column)`** is what to SELECT for each column, so that what you serve is exactly what the SQL
  compared:
  - a date as `YYYY-MM-DD`, a datetimeoffset as UTC `…Z`, the others `YYYY-MM-DDTHH:MM:SS.sss`;
  - numbers as float;
  - a geometry as WKB (`STAsBinary()`, exact).
- **Spatial filters (Basic Spatial Functions):**
  - S_INTERSECTS on `geometry` columns is `column.STDistance(literal) <= 0`, which uses the spatial index;
  - the literal is bound as WKB (exact) in the column's SRID (`SqlColumn.srid`, default 4326). SQL Server's geometry
    is planar whatever its SRID;
  - an empty geometry intersects nothing.
  - S_DISJOINT belongs to Spatial Functions: write NOT S_INTERSECTS.

**Where SQL Server differs, documented:**
- **Spatial Functions aren't translated.** SQL Server computes relations on a grid, which differs from GEOS in
  thousands of boundary cases; no T-SQL form avoids it.
- **S_INTERSECTS on boundaries:** a point within rounding of a boundary may be decided either way. Measured: 10 answers in
  11,610 queries on the US states, every one a point within 1.4e-14°.
- **An invalid geometry** (a self-intersecting polygon), stored or as a literal, makes the query fail: SQL Server
  refuses it. Store valid geometries; validate literals.
- **Stored text is assumed to be in NFC** (T-SQL has no normalization). CASEI and ACCENTI normalize with the package's
  own tables. Characters added after Unicode 15.0.0 can compare differently.
- **An nvarchar column in `Latin1_General_100_BIN2`** can't be compared exactly: converting it loses characters past
  U+FFFF. Of 5,508 collations, it is the only one measured to.
- **`^`:** a result within 0.2% of the largest float is NULL, and powers may differ in the last digit.

- **Tested on real databases:** thousands of generated filters give the same features from SQL Server as from
  `evaluate` on what SQL Server serves, on SQL Server 2022 and 2025 (demo-server's tests; not in CI).
- **The classes:** every class the package implements but Spatial Functions
  (`sqlConformance({ dialect: "sqlserver" })`); all need `sqlserverFunctions` installed.
