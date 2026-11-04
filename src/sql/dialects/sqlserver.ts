/**
 * Dialect `sqlserver`, for SQL Server 2022 and later, with Basic Spatial Functions (S_INTERSECTS, S_DISJOINT):
 * - columns are statically typed; `SqlColumn.sqlType` (the type as `sys.types` names it) picks the view;
 * - text compares as its UTF-8 bytes (`CONVERT` to a `Latin1_General_100_BIN2_UTF8` varchar, as varbinary): code point
 *   order, and no blank padding (SQL Server compares `'a' = 'a '` as TRUE in every collation). It costs the column's
 *   index. Stored text is assumed to be in NFC (T-SQL has no normalization). An nvarchar column in
 *   `Latin1_General_100_BIN2`, the one collation measured to lose characters past U+FFFF on conversion, can't be
 *   compared exactly;
 * - LIKE is SQL Server's when the pattern has no `_`, else `cql2_like`: SQL Server's `_` doesn't match one code point
 *   (2022: one UTF-8 byte; 2025: right, but for trailing blanks). SQL Server's LIKE ignores the value's trailing blanks:
 *   a `|` after both keeps them;
 * - numbers compare as float, literals bound as text (a subnormal one scaled, since SQL Server reads its text as 0);
 * - dates compare as dates, instants (datetimeoffset) as epoch milliseconds in UTC, truncated as `evaluate`'s; the
 *   other date and time types have no zone and compare as the text they are served as (see {@link sqlserverValue});
 * - T-SQL has no boolean values: a condition used as a value is written as 1, 0 or NULL (`Dialect.truth`);
 * - CASEI, ACCENTI, LIKE with `_`, the reading of dates and instants from text, and arithmetic (whose errors would fail
 *   the whole query) use the functions {@link sqlserverFunctions} creates once in the database. SQL Server calls a
 *   scalar function only by a two-part name: the schema is `functionSchema`, else `dbo`.
 * - S_INTERSECTS through `column.STDistance(literal) <= 0` on `geometry` (planar whatever its SRID; `geography` isn't
 *   compared), which uses the spatial index. SQL Server computes on a grid (its relations since 2012): a point within
 *   rounding of a boundary may be decided either way (measured: points within 1.4e-14° of a US state's boundary). The
 *   other relations differ from GEOS in thousands of boundary cases, so Spatial Functions aren't translated. Literals
 *   are bound as WKB (exact), in the column's SRID (`SqlColumn.srid`, default 4326).
 * Parameters are named: bind `params[i]` as `p<i+1>` (`request.input("p1", params[0])` with the `mssql` driver).
 */
import type { Fold } from "../../core/folds.js";
import type { ArithmeticOperator, BboxLiteral, Geometry, Position, SpatialLiteral } from "../../core/types.js";
import { accentMarkEntries, caseFoldingEntries } from "../../evaluate/strings.js";
import { COMBINING_CLASSES, COMPOSITIONS, DECOMPOSITIONS } from "./composition.js";
import { quote, type Dialect, type Kind, type PairSide, type SqlColumn, type SqlValue, type View } from "../types.js";

type MsClass = "text" | "number" | "float" | "boolean" | "date" | "timestamp" | "timestamptz" | "geometry" | "other";

/** A declared type in lower case, without type modifiers: "decimal(12, 2)" → "decimal". */
const bareType = (sqlType: string): string => sqlType.toLowerCase().replace(/\(.*\)/, "").replace(/\s+/g, " ").trim();

/** What a SQL Server column holds, from its declared type, or else from its queryable. */
function msClass(column: SqlColumn): MsClass {
  if (column.sqlType === undefined) {
    if (typeof column.format === "string" && column.format.startsWith("geometry-")) return "geometry";
    if (column.type === "string") return column.format === "date" ? "date" : column.format === "date-time" ? "timestamptz" : "text";
    if (column.type === "integer" || column.type === "number") return "number";
    return column.type === "boolean" ? "boolean" : "other";
  }
  const t = bareType(column.sqlType);
  if (["varchar", "char", "nvarchar", "nchar"].includes(t)) return "text";
  if (t === "float") return "float";
  if (["real", "int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney"].includes(t)) return "number";
  if (t === "bit") return "boolean";
  if (t === "date") return "date";
  if (["datetime2", "datetime", "smalldatetime"].includes(t)) return "timestamp";
  if (t === "datetimeoffset") return "timestamptz";
  if (t === "geometry") return "geometry";
  return "other";
}

/** `YYYY-MM-DDTHH:MM:SS.sss` of a datetime2 expression, the milliseconds truncated. */
const isoText = (sql: string): string =>
  `CONVERT(varchar(19), ${sql}, 126) + '.' + RIGHT('00' + CAST(DATEPART(millisecond, ${sql}) AS varchar(3)), 3)`;

/** The text a column's value is served as, for the classes served as strings. */
function msText(sql: string, cls: MsClass): string | undefined {
  switch (cls) {
    case "text":
      return sql;
    case "date":
      return `CONVERT(varchar(10), ${sql}, 23)`;
    case "timestamp":
      return isoText(sql);
    case "timestamptz":
      return `${isoText(`CAST(SWITCHOFFSET(${sql}, '+00:00') AS datetime2(7))`)} + 'Z'`;
    default:
      return undefined;
  }
}

/**
 * The SQL expression to SELECT for a column, so that the application serves exactly the values the `sqlserver`
 * dialect compares: a date as `YYYY-MM-DD`; datetime2, datetime and smalldatetime as `YYYY-MM-DDTHH:MM:SS.sss`
 * (truncated); a datetimeoffset as UTC `YYYY-MM-DDTHH:MM:SS.sssZ`; numbers as float; a geometry as WKB. Text (char and nchar with their
 * padding) and bit as they are. `undefined` for a type the dialect can't compare (text, ntext, xml, binary…).
 */
export function sqlserverValue(sqlColumn: string, column: SqlColumn): string | undefined {
  const sql = quote(sqlColumn);
  const cls = msClass(column);
  if (cls === "boolean" || cls === "float") return sql;
  if (cls === "number") return `CAST(${sql} AS float)`;
  if (cls === "geometry") return `${sql}.STAsBinary()`;
  return msText(sql, cls);
}

/** Text as its UTF-8 bytes: code point order, and no blank padding. */
const bytes = (sql: string): string =>
  `CAST(CONVERT(varchar(max), ${sql} COLLATE Latin1_General_100_BIN2_UTF8) AS varbinary(max))`;
const utf8 = (sql: string): string => `CONVERT(varchar(max), ${sql} COLLATE Latin1_General_100_BIN2_UTF8)`;
/** ASCII text (days, served dates) in byte order, whatever the database's collation (a linguistic one ignores `-`). */
const BIN2 = " COLLATE Latin1_General_BIN2";

/** Whether a CQL2 pattern has an unescaped `_`, which SQL Server's LIKE matches as one UTF-16 code unit. */
const hasOne = (pattern: string): boolean => /(?:^|[^\\])(?:\\\\)*_/.test(pattern);

/**
 * A CQL2 LIKE pattern for SQL Server's `LIKE … ESCAPE '\'`: `[` escaped (it opens a set), `\x` is `x` for any other `x`
 * than `%`, `_`, `\` and `[`, and a lone trailing `\` a backslash.
 */
export function sqlserverLikePattern(pattern: string): string {
  let out = "";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "[") out += "\\[";
    else if (c !== "\\") out += c;
    else if (i + 1 === chars.length) out += "\\\\";
    else {
      const next = chars[++i]!;
      out += next === "%" || next === "_" || next === "\\" || next === "[" ? `\\${next}` : next;
    }
  }
  return out;
}

/**
 * A text view: compared as UTF-8 bytes, LIKE SQL Server's or cql2_like's. SQL Server's LIKE ignores the value's
 * trailing blanks (`'a ' LIKE 'a'` is TRUE): a `|` after both the value and the pattern keeps them.
 */
function textView(text: string, fn: (name: string) => string): View {
  return {
    sql: bytes(text),
    cast: "",
    wrap: bytes,
    like: (pattern, param) =>
      hasOne(pattern)
        ? `${fn("cql2_like")}(${text}, ${param(pattern)}) = 1`
        : `${utf8(`(${text} + N'|')`)} LIKE ${utf8(`(${param(sqlserverLikePattern(pattern))} + N'|')`)} ESCAPE '\\'`,
  };
}

/**
 * A number literal as text, which SQL Server reads exactly whatever the session's language, but for subnormal numbers
 * (below 2^-1022), which it reads as 0: those are bound times 2^54 and scaled back, both exact.
 */
const subnormal = (value: SqlValue): boolean => typeof value === "number" && value !== 0 && Math.abs(value) < 2 ** -1022;
const numberText = (value: SqlValue): SqlValue => (subnormal(value) ? (value as number) * 2 ** 54 : (value as number)).toExponential();
const asFloat = (p: string, value: SqlValue): string =>
  subnormal(value) ? `CAST(${p} AS float) * POWER(CAST(2 AS float), -54)` : `CAST(${p} AS float)`;
/** Epoch milliseconds of a datetimeoffset, in UTC, truncated (DATEDIFF_BIG counts the boundaries crossed). */
const epochMs = (sql: string): string => `DATEDIFF_BIG(millisecond, CAST('1970-01-01T00:00:00Z' AS datetimeoffset), ${sql})`;

function sqlserverView(sql: string, kind: Kind, column: SqlColumn, fn: (name: string) => string, folds: readonly Fold[]): View | undefined {
  const cls = msClass(column);
  const text = msText(sql, cls);
  switch (kind) {
    case "text":
      return text ? textView(text, fn) : undefined;
    case "fold":
      return text ? textView(folds.reduce((expression, fold) => `${fn(`cql2_${fold}`)}(${expression})`, text), fn) : undefined;
    case "number":
      if (cls === "float") return { sql, cast: "", wrap: asFloat, value: numberText };
      return cls === "number" ? { sql: `CAST(${sql} AS float)`, cast: "", wrap: asFloat, value: numberText } : undefined;
    case "boolean":
      return cls === "boolean" ? { sql, cast: "" } : undefined;
    case "day":
      // A date against a literal as a date (the index applies); against another column, as its YYYY-MM-DD text.
      if (cls === "date") return { sql, cast: "", wrap: (p) => `CAST(${p} AS date)`, pair: `CONVERT(varchar(10), ${sql}, 23)${BIN2}` };
      return cls === "text" ? { sql: `${fn("cql2_day")}(${sql})${BIN2}`, cast: "", wrap: (p) => `CAST(${p} AS varchar(10))` } : undefined;
    case "instant":
      if (cls === "timestamptz") return { sql: epochMs(sql), cast: "", wrap: (p) => `CAST(${p} AS bigint)` };
      return cls === "text" ? { sql: `${fn("cql2_instant")}(${sql})`, cast: "", wrap: (p) => `CAST(${p} AS bigint)` } : undefined;
  }
}

// --- Spatial -----------------------------------------------------------------------------------------------------

/** A literal as ISO WKB (2D, little-endian), in hex: a box as a polygon, across the antimeridian two. */
export function sqlserverWkb(literal: SpatialLiteral): string {
  const bytes: number[] = [];
  const u32 = (n: number) => bytes.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  const view = new DataView(new ArrayBuffer(8));
  const f64 = (x: number) => {
    view.setFloat64(0, x, true);
    for (let i = 0; i < 8; i++) bytes.push(view.getUint8(i));
  };
  const point = (p: Position) => (f64(p[0]), f64(p[1]));
  const points = (ps: readonly Position[]) => (u32(ps.length), ps.forEach(point));
  const rings = (rs: readonly (readonly Position[])[]) => (u32(rs.length), rs.forEach(points));
  const put = (g: Geometry) => {
    bytes.push(1);
    switch (g.type) {
      case "Point": u32(1); point(g.coordinates); break;
      case "LineString": u32(2); points(g.coordinates); break;
      case "Polygon": u32(3); rings(g.coordinates); break;
      case "MultiPoint": u32(4); u32(g.coordinates.length); g.coordinates.forEach((c) => put({ type: "Point", coordinates: c })); break;
      case "MultiLineString": u32(5); u32(g.coordinates.length); g.coordinates.forEach((c) => put({ type: "LineString", coordinates: c })); break;
      case "MultiPolygon": u32(6); u32(g.coordinates.length); g.coordinates.forEach((c) => put({ type: "Polygon", coordinates: c })); break;
      case "GeometryCollection": u32(7); u32(g.geometries.length); g.geometries.forEach(put); break;
    }
  };
  if ("bbox" in literal && !("type" in literal)) {
    const b = (literal as BboxLiteral).bbox;
    const [west, south, east, north] = b.length === 4 ? b : [b[0], b[1], b[3], b[4]];
    const box = (w: number, e: number): Position[][] => [[[w, south], [e, south], [e, north], [w, north], [w, south]]];
    put(west > east ? { type: "MultiPolygon", coordinates: [box(west, 180), box(-180, east)] } : { type: "Polygon", coordinates: box(west, east) });
  } else put(literal as Geometry);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** A geometry column's SRID: `srid`, else 4326 (a literal in another SRID than the column's would give NULL). */
const sridOf = (column: SqlColumn): number => column.srid ?? 4326;

/** The literal as a geometry in `srid`, from its WKB (exact; the text forms are not needed). */
const literalSql = (literal: SpatialLiteral, srid: number, param: (value: SqlValue) => string): string =>
  `geometry::STGeomFromWKB(CONVERT(varbinary(max), ${param(sqlserverWkb(literal))}, 2), ${srid})`;

/**
 * S_INTERSECTS of two geometries: at distance 0. An empty geometry intersects nothing: FALSE, as in `evaluate`, where
 * STDistance would give NULL. A NULL geometry stays NULL.
 */
const meets = (a: string, b: string, aEmpty = true, bEmpty = false): string =>
  `(${aEmpty ? `${a}.STIsEmpty() = 0 AND ` : ""}${bEmpty ? `${b}.STIsEmpty() = 0 AND ` : ""}${a}.STDistance(${b}) <= 0)`;

function sqlserverIntersects(sql: string, column: SqlColumn, literal: SpatialLiteral, param: (value: SqlValue) => string): string | undefined {
  return msClass(column) === "geometry" ? meets(sql, literalSql(literal, sridOf(column), param)) : undefined;
}

/** S_INTERSECTS of two geometry columns (Property-Property Comparisons); the other relations aren't translated. */
function sqlserverPair(relation: string, a: PairSide, b: PairSide): string | undefined {
  if (relation !== "s_intersects" || "literal" in a || "literal" in b) return undefined;
  if (msClass(a.column) !== "geometry" || msClass(b.column) !== "geometry") return undefined;
  return meets(a.sql, b.sql, true, true);
}

export const sqlserver: Dialect = {
  placeholder: (n) => `@p${n}`,
  number: (value, param) => asFloat(param(numberText(value)), value),
  arithmetic: (op: ArithmeticOperator, a, b, fn) => `${fn("cql2_arithmetic")}('${op}', ${a}, ${b})`,
  true: "1 = 1",
  false: "1 = 0",
  never: "1 = NULL",
  truth: (condition) => `CASE WHEN ${condition} THEN 1 WHEN NOT (${condition}) THEN 0 END`,
  functionSchema: "dbo",
  boolean: (value) => value,
  instant: (ms) => String(ms),
  view: sqlserverView,
  like: (v, pattern, param) => v.like!(pattern, param),
  intersects: (sql, column, literal, param) => sqlserverIntersects(sql, column, literal, param),
  spatialPair: (relation, a, b) => sqlserverPair(relation, a, b),
};

// --- sqlserverFunctions ------------------------------------------------------------------------------------------

/** `INSERT … SELECT FROM (VALUES …)` of integer rows (no 1,000-row limit, unlike `INSERT … VALUES`). */
const insertRows = (table: string, columns: readonly string[], rows: readonly (readonly number[])[]): string =>
  `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM (VALUES\n${rows.map((r) => `(${r.join(", ")})`).join(",\n")}) v (${columns.join(", ")})`;

/** A code point list "a,b,c" in hex as numbers. */
const hexList = (text: string): number[][] => text.split(";").map((e) => e.split(",").map((h) => parseInt(h, 16)));

/**
 * The T-SQL batches that create, in `schema` (default `dbo`), what the `sqlserver` dialect calls: run them once, in
 * order, each as a batch of its own (the `mssql` driver's `batch`; in a script, separated by `GO`), as a user who may
 * create tables and functions there. Safe to run again. Needs SQL Server 2022 or later. They
 * create (or replace):
 * - the package's Unicode 15.0.0 tables, as code points: `cql2_casefold` (CaseFolding, statuses C and F),
 *   `cql2_accent_marks` (the nonspacing marks ACCENTI removes), `cql2_decomposition`, `cql2_combining` and
 *   `cql2_compose` (for NFD and NFC, which T-SQL lacks);
 * - `cql2_casei(t)` and `cql2_accenti(t)`: as `evaluate` computes them (NFD, fold or remove the marks, NFC), on code
 *   points, whatever the database's collation;
 * - `cql2_like(t, pattern)`: LIKE on code points (`%`, `_` one code point, `\` the escape), 1 or 0;
 * - `cql2_day(t)`: a `YYYY-MM-DD` text that exists (proleptic Gregorian), else NULL;
 * - `cql2_instant(t)`: an ISO 8601 date-time with `Z` or an offset that exists, as epoch milliseconds (truncated), else
 *   NULL. The same strict rules as `evaluate`;
 * - `cql2_arithmetic(op, a, b)`: `a op b` of two floats, exactly as `evaluate` computes it, NULL for a result that
 *   isn't a finite number, and never an error (SQL Server would fail the query): the overflow is tested from the
 *   operands' exponents before the operation. `^` close to overflow may give NULL where `evaluate` gives a number.
 */
export function sqlserverFunctions(schema = "dbo"): string[] {
  const s = `${quote(schema)}.`;
  const table = (name: string, columns: string) =>
    `IF OBJECT_ID(N'${s}${name}', N'U') IS NULL CREATE TABLE ${s}${name} (${columns});\nTRUNCATE TABLE ${s}${name};`;
  const exploded = (entries: readonly (readonly number[])[]) => entries.flatMap(([code, ...parts]) => parts.map((cp, i) => [code!, i + 1, cp]));
  const folds = caseFoldingEntries().map(([from, to]) => [from, ...[...to].map((c) => c.codePointAt(0)!)]);
  const classes = COMBINING_CLASSES.split(";").flatMap((e) => {
    const [start, count, ccc] = e.split(",");
    return Array.from({ length: parseInt(count!, 16) }, (_, i) => [parseInt(start!, 16) + i, Number(ccc)]);
  });
  // A string's code points, decoding UTF-16 itself (Latin1_General_100_BIN2: SUBSTRING counts code units whatever the
  // database's collation; a pair of surrogates is one code point).
  // 1 … n without GENERATE_SERIES, which needs compatibility level 160: up to 16^5 code units.
  const sixteen = "(VALUES (0),(0),(0),(0),(0),(0),(0),(0),(0),(0),(0),(0),(0),(0),(0),(0))";
  const series = (n: string) =>
    `(SELECT TOP (${n}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM ${sixteen} a (x) CROSS JOIN ${sixteen} b (x) CROSS JOIN ${sixteen} c (x) CROSS JOIN ${sixteen} d (x) CROSS JOIN ${sixteen} e (x))`;
  const units = (t: string) => `(SELECT n AS pos, UNICODE(SUBSTRING(${t} COLLATE Latin1_General_100_BIN2, n, 1)) AS u FROM ${series(`CAST(DATALENGTH(${t}) / 2 AS int)`)} g)`;
  const codePoints = (t: string, into: string) => `INSERT INTO ${into} (pos, cp)
  SELECT pos, CASE WHEN u BETWEEN 55296 AND 56319 AND nu BETWEEN 56320 AND 57343 THEN 65536 + (u - 55296) * 1024 + (nu - 56320) ELSE u END
  FROM (SELECT pos, u, LEAD(u) OVER (ORDER BY pos) AS nu, LAG(u) OVER (ORDER BY pos) AS pu FROM ${units(t)} x) y
  WHERE NOT (u BETWEEN 56320 AND 57343 AND pu BETWEEN 55296 AND 56319);`;
  // NFD of @from into @to: the table's decompositions, Hangul syllables arithmetically.
  const nfd = (from: string, to: string) => `INSERT INTO ${to} (pos, cp)
  SELECT f.pos * 8 + ISNULL(d.ord, 0), ISNULL(d.cp, f.cp) FROM ${from} f LEFT JOIN ${s}cql2_decomposition d ON d.code = f.cp
  WHERE f.cp NOT BETWEEN 44032 AND 55203
  UNION ALL SELECT pos * 8 + 1, 4352 + (cp - 44032) / 588 FROM ${from} WHERE cp BETWEEN 44032 AND 55203
  UNION ALL SELECT pos * 8 + 2, 4449 + (cp - 44032) % 588 / 28 FROM ${from} WHERE cp BETWEEN 44032 AND 55203
  UNION ALL SELECT pos * 8 + 3, 4519 + (cp - 44032) % 28 FROM ${from} WHERE cp BETWEEN 44032 AND 55203 AND (cp - 44032) % 28 > 0;`;
  // Canonical ordering of @from into @to: within each run of characters after a starter, sorted by class, stably.
  const reorder = (from: string, to: string) => `INSERT INTO ${to} (pos, cp, cc)
  SELECT ROW_NUMBER() OVER (ORDER BY seg, CASE WHEN cc = 0 THEN 0 ELSE 1 END, cc, pos), cp, cc
  FROM (SELECT pos, cp, cc, SUM(CASE WHEN cc = 0 THEN 1 ELSE 0 END) OVER (ORDER BY pos ROWS UNBOUNDED PRECEDING) AS seg
        FROM (SELECT f.pos, f.cp, ISNULL(c.class, 0) AS cc FROM ${from} f LEFT JOIN ${s}cql2_combining c ON c.code = f.cp) x) y;`;
  const fold = (casei: boolean) => `CREATE OR ALTER FUNCTION ${s}cql2_${casei ? "casei" : "accenti"}(@t nvarchar(max)) RETURNS nvarchar(max) AS
BEGIN
  IF @t IS NULL RETURN NULL;
  -- Printable ASCII: nothing decomposes${casei ? ", and folding is A-Z to a-z" : " or is a mark"}.
  IF @t COLLATE Latin1_General_BIN2 NOT LIKE N'%[^ -~]%' RETURN ${casei ? "TRANSLATE(@t COLLATE Latin1_General_BIN2, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')" : "@t"};
  DECLARE @a TABLE (pos bigint PRIMARY KEY, cp int);
  DECLARE @b TABLE (pos bigint PRIMARY KEY, cp int);
  DECLARE @c TABLE (pos bigint PRIMARY KEY, cp int, cc int);
  DECLARE @d TABLE (pos bigint PRIMARY KEY, cp int);
  DECLARE @e TABLE (pos bigint PRIMARY KEY, cp int);
  DECLARE @r TABLE (pos bigint PRIMARY KEY, cp int, cc int);
  DECLARE @out TABLE (pos bigint PRIMARY KEY, cp int);
  ${codePoints("@t", "@a")}
  ${nfd("@a", "@b")}
  ${reorder("@b", "@c")}
  ${casei
    ? `INSERT INTO @d (pos, cp) SELECT c.pos * 4 + ISNULL(f.ord, 0), ISNULL(f.cp, c.cp) FROM @c c LEFT JOIN ${s}cql2_casefold f ON f.code = c.cp;
  -- Folding can give characters that decompose, or a starter where a mark was (U+0345): NFD again.
  ${nfd("@d", "@e")}`
    : `INSERT INTO @e (pos, cp) SELECT pos, cp FROM @c c WHERE NOT EXISTS (SELECT 1 FROM ${s}cql2_accent_marks m WHERE m.code = c.cp);`}
  ${reorder("@e", "@r")}
  -- Canonical composition (UAX #15): a character composes with the last starter unless one between them has class 0,
  -- or a class not lower than its own; Hangul arithmetically.
  DECLARE @i bigint = 1, @n bigint = (SELECT COUNT(*) FROM @r), @k bigint = 0, @cp int, @cc int, @starter bigint = NULL, @scp int, @last int = 256, @x int;
  WHILE @i <= @n
  BEGIN
    SELECT @cp = cp, @cc = cc FROM @r WHERE pos = @i;
    SET @x = NULL;
    IF @starter IS NOT NULL AND (@last < @cc OR @last = 0)
    BEGIN
      SELECT @x = composite FROM ${s}cql2_compose WHERE starter = @scp AND mark = @cp;
      IF @x IS NULL AND @scp BETWEEN 4352 AND 4370 AND @cp BETWEEN 4449 AND 4469 SET @x = 44032 + ((@scp - 4352) * 21 + (@cp - 4449)) * 28;
      IF @x IS NULL AND @scp BETWEEN 44032 AND 55203 AND (@scp - 44032) % 28 = 0 AND @cp BETWEEN 4520 AND 4546 SET @x = @scp + @cp - 4519;
    END
    IF @x IS NOT NULL
    BEGIN
      UPDATE @out SET cp = @x WHERE pos = @starter;
      SET @scp = @x;
    END
    ELSE
    BEGIN
      SET @k += 1;
      INSERT INTO @out (pos, cp) VALUES (@k, @cp);
      IF @cc = 0 BEGIN SET @starter = @k; SET @scp = @cp; END;
      SET @last = @cc;
    END
    SET @i += 1;
  END
  RETURN ISNULL((SELECT STRING_AGG(CASE WHEN cp > 65535 THEN CAST(NCHAR(55296 + (cp - 65536) / 1024) + NCHAR(56320 + (cp - 65536) % 1024) AS nvarchar(max))
    ELSE CAST(NCHAR(cp) AS nvarchar(max)) END, N'') WITHIN GROUP (ORDER BY pos) FROM @out), N'');
END`;
  return [
    table("cql2_casefold", "code int NOT NULL, ord int NOT NULL, cp int NOT NULL, PRIMARY KEY (code, ord)"),
    insertRows(`${s}cql2_casefold`, ["code", "ord", "cp"], exploded(folds)),
    table("cql2_accent_marks", "code int PRIMARY KEY"),
    insertRows(`${s}cql2_accent_marks`, ["code"], accentMarkEntries().map((c) => [c])),
    table("cql2_decomposition", "code int NOT NULL, ord int NOT NULL, cp int NOT NULL, PRIMARY KEY (code, ord)"),
    insertRows(`${s}cql2_decomposition`, ["code", "ord", "cp"], exploded(hexList(DECOMPOSITIONS))),
    table("cql2_combining", "code int PRIMARY KEY, class int NOT NULL"),
    insertRows(`${s}cql2_combining`, ["code", "class"], classes),
    table("cql2_compose", "starter int NOT NULL, mark int NOT NULL, composite int NOT NULL, PRIMARY KEY (starter, mark)"),
    insertRows(`${s}cql2_compose`, ["starter", "mark", "composite"], hexList(COMPOSITIONS)),
    fold(true),
    fold(false),
    `CREATE OR ALTER FUNCTION ${s}cql2_like(@t nvarchar(max), @p nvarchar(max)) RETURNS int AS
BEGIN
  IF @t IS NULL OR @p IS NULL RETURN NULL;
  DECLARE @s TABLE (pos bigint PRIMARY KEY, cp int);
  DECLARE @q TABLE (pos bigint PRIMARY KEY, cp int);
  DECLARE @k TABLE (pos int IDENTITY PRIMARY KEY, kind int, cp int); -- 0 a character, 1 _, 2 %
  ${codePoints("@t", "@s")}
  ${codePoints("@p", "@q")}
  -- The pattern as tokens: \\x is x, a lone trailing \\ a backslash.
  DECLARE @j bigint = (SELECT MIN(pos) FROM @q), @c int, @esc bit = 0;
  WHILE @j IS NOT NULL
  BEGIN
    SELECT @c = cp FROM @q WHERE pos = @j;
    IF @esc = 1 BEGIN INSERT INTO @k (kind, cp) VALUES (0, @c); SET @esc = 0; END
    ELSE IF @c = 92 SET @esc = 1
    ELSE INSERT INTO @k (kind, cp) VALUES (CASE @c WHEN 95 THEN 1 WHEN 37 THEN 2 ELSE 0 END, @c);
    SET @j = (SELECT MIN(pos) FROM @q WHERE pos > @j);
  END
  IF @esc = 1 INSERT INTO @k (kind, cp) VALUES (0, 92);
  -- Wildcard matching, backtracking to the last %.
  DECLARE @t2 TABLE (i int PRIMARY KEY, cp int);
  INSERT INTO @t2 (i, cp) SELECT ROW_NUMBER() OVER (ORDER BY pos), cp FROM @s;
  DECLARE @n int = (SELECT COUNT(*) FROM @t2), @m int = (SELECT COUNT(*) FROM @k), @i int = 1, @x int = 1, @star int = 0, @mark int = 0, @kind int, @kc int, @tc int;
  WHILE @i <= @n
  BEGIN
    SELECT @tc = cp FROM @t2 WHERE i = @i;
    SET @kind = NULL;
    SELECT @kind = kind, @kc = cp FROM @k WHERE pos = @x;
    IF @kind = 1 OR (@kind = 0 AND @kc = @tc) BEGIN SET @i += 1; SET @x += 1; END
    ELSE IF @kind = 2 BEGIN SET @star = @x; SET @mark = @i; SET @x += 1; END
    ELSE IF @star > 0 BEGIN SET @x = @star + 1; SET @mark += 1; SET @i = @mark; END
    ELSE RETURN 0;
  END
  WHILE @x <= @m AND (SELECT kind FROM @k WHERE pos = @x) = 2 SET @x += 1;
  RETURN CASE WHEN @x > @m THEN 1 ELSE 0 END;
END`,
    `CREATE OR ALTER FUNCTION ${s}cql2_real_day(@y int, @m int, @d int) RETURNS bit AS
BEGIN
  IF @y < 1 OR @m < 1 OR @m > 12 OR @d < 1 RETURN 0;
  RETURN CASE WHEN @d <= CASE WHEN @m = 2 THEN CASE WHEN (@y % 4 = 0 AND @y % 100 <> 0) OR @y % 400 = 0 THEN 29 ELSE 28 END
    WHEN @m IN (4, 6, 9, 11) THEN 30 ELSE 31 END THEN 1 ELSE 0 END;
END`,
    `CREATE OR ALTER FUNCTION ${s}cql2_day(@t nvarchar(max)) RETURNS varchar(10) AS
BEGIN
  IF DATALENGTH(@t) = 20 AND @t COLLATE Latin1_General_BIN2 LIKE N'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
     AND ${s}cql2_real_day(CAST(SUBSTRING(@t, 1, 4) AS int), CAST(SUBSTRING(@t, 6, 2) AS int), CAST(SUBSTRING(@t, 9, 2) AS int)) = 1
    RETURN CAST(@t AS varchar(10));
  RETURN NULL;
END`,
    `CREATE OR ALTER FUNCTION ${s}cql2_instant(@t nvarchar(max)) RETURNS bigint AS
BEGIN
  -- YYYY-MM-DDTHH:MM[:SS[.fraction]](Z|+HH:MM|-HH:MM), T and Z in either case, as evaluate reads it.
  DECLARE @u nvarchar(max) = @t COLLATE Latin1_General_BIN2;
  DECLARE @n int = DATALENGTH(@u) / 2, @pos int = 17, @sec bigint = 0, @ms bigint = 0, @sgn int = 0, @oh int = 0, @om int = 0, @rest nvarchar(max);
  IF @n IS NULL OR @n < 17 OR LEFT(@u, 16) NOT LIKE N'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][Tt][0-9][0-9]:[0-9][0-9]' RETURN NULL;
  IF SUBSTRING(@u, 17, 1) = N':'
  BEGIN
    IF SUBSTRING(@u, 18, 2) NOT LIKE N'[0-9][0-9]' RETURN NULL;
    SET @sec = CAST(SUBSTRING(@u, 18, 2) AS int);
    SET @pos = 20;
    IF SUBSTRING(@u, 20, 1) = N'.'
    BEGIN
      SET @pos = 21;
      WHILE @pos <= @n AND SUBSTRING(@u, @pos, 1) LIKE N'[0-9]' SET @pos += 1;
      IF @pos = 21 RETURN NULL;
      SET @ms = CAST(LEFT(SUBSTRING(@u, 21, @pos - 21) + N'000', 3) AS int);
    END
  END
  SET @rest = SUBSTRING(@u, @pos, @n);
  IF DATALENGTH(@rest) = 2 AND @rest IN (N'Z', N'z') SET @sgn = 0; -- the length too: '=' ignores trailing blanks
  ELSE IF DATALENGTH(@rest) = 12 AND @rest LIKE N'[+-][0-9][0-9]:[0-9][0-9]'
  BEGIN
    SET @sgn = CASE LEFT(@rest, 1) WHEN N'-' THEN -1 ELSE 1 END;
    SET @oh = CAST(SUBSTRING(@rest, 2, 2) AS int);
    SET @om = CAST(SUBSTRING(@rest, 5, 2) AS int);
  END
  ELSE RETURN NULL;
  DECLARE @y bigint = CAST(LEFT(@u, 4) AS int), @mo bigint = CAST(SUBSTRING(@u, 6, 2) AS int), @d bigint = CAST(SUBSTRING(@u, 9, 2) AS int),
          @h bigint = CAST(SUBSTRING(@u, 12, 2) AS int), @mi bigint = CAST(SUBSTRING(@u, 15, 2) AS int);
  IF ${s}cql2_real_day(@y, @mo, @d) = 0 OR @h > 23 OR @mi > 59 OR @sec > 59 OR @oh > 23 OR @om > 59 RETURN NULL;
  -- Days since 1970-01-01 in the proleptic Gregorian calendar.
  DECLARE @yy bigint = @y - CASE WHEN @mo <= 2 THEN 1 ELSE 0 END;
  DECLARE @era bigint = CASE WHEN @yy >= 0 THEN @yy ELSE @yy - 399 END / 400;
  DECLARE @yoe bigint = @yy - @era * 400;
  DECLARE @doy bigint = (153 * ((@mo + 9) % 12) + 2) / 5 + @d - 1;
  DECLARE @doe bigint = @yoe * 365 + @yoe / 4 - @yoe / 100 + @doy;
  RETURN (@era * 146097 + @doe - 719468) * 86400000 + @h * 3600000 + @mi * 60000 + @sec * 1000 + @ms - @sgn * (@oh * 60 + @om) * 60000;
END`,
    `CREATE OR ALTER FUNCTION ${s}cql2_arithmetic(@op varchar(3), @a float, @b float) RETURNS float AS
BEGIN
  -- No operation that could fail is run: SQL Server would fail the whole query (overflow, division by zero, a power
  -- outside its domain), where evaluate gives NULL. Overflow is decided from the exponents (the float's bits), and at
  -- the boundary by the operation on halves or on operands scaled by powers of two, which round alike.
  IF @a IS NULL OR @b IS NULL RETURN NULL;
  -- The exponents, from the bits; a subnormal number's (field 0) read on it times 2^54.
  DECLARE @ea int = (CAST(SUBSTRING(CAST(@a AS binary(8)), 1, 2) AS int) & 32752) / 16 - 1023;
  DECLARE @eb int = (CAST(SUBSTRING(CAST(@b AS binary(8)), 1, 2) AS int) & 32752) / 16 - 1023;
  IF @ea = -1023 AND @a <> 0 SET @ea = (CAST(SUBSTRING(CAST(@a * POWER(CAST(2 AS float), 54) AS binary(8)), 1, 2) AS int) & 32752) / 16 - 1077;
  IF @eb = -1023 AND @b <> 0 SET @eb = (CAST(SUBSTRING(CAST(@b * POWER(CAST(2 AS float), 54) AS binary(8)), 1, 2) AS int) & 32752) / 16 - 1077;
  DECLARE @max float = CAST('1.7976931348623157e+308' AS float), @down float = POWER(CAST(2 AS float), -512), @up float = POWER(CAST(2 AS float), 512);
  DECLARE @half float = @max / 2, @one float = (@max * @down) * @down; -- the largest float over 2, over 2^1024 (exact)
  DECLARE @q float, @t float;
  IF @op IN ('+', '-')
  BEGIN
    IF @ea >= 1022 OR @eb >= 1022
      IF ABS(@a / 2 + CASE @op WHEN '+' THEN @b ELSE -@b END / 2) > @half RETURN NULL;
    RETURN CASE @op WHEN '+' THEN @a + @b ELSE @a - @b END;
  END
  IF @op = '*'
  BEGIN
    IF @a = 0 OR @b = 0 RETURN 0;
    IF @ea + @eb >= 1024 RETURN NULL;
    IF @ea + @eb >= 1022 AND ABS((@a * @down) * (@b * @down)) > @one RETURN NULL;
    RETURN @a * @b;
  END
  IF @op IN ('/', 'div', '%')
  BEGIN
    IF @b = 0 RETURN NULL;
    IF @a = 0 RETURN CASE @op WHEN '%' THEN @a ELSE 0 END;
    IF @ea - @eb >= 1025 RETURN NULL;
    IF @ea - @eb >= 1023 AND ABS((@a * @down) / (@b * @up)) > @one RETURN NULL;
    SET @q = @a / @b;
    IF @op = '/' RETURN @q;
    SET @t = ROUND(@q, 0, 1);
    IF @op = 'div' RETURN @t;
    -- a - b * trunc(a / b), with b * trunc(a / b) guarded as a product.
    IF @t = 0 RETURN @a;
    SET @ea = (CAST(SUBSTRING(CAST(@t AS binary(8)), 1, 2) AS int) & 32752) / 16 - 1023; -- a whole number: never subnormal
    IF @ea + @eb >= 1024 RETURN NULL;
    IF @ea + @eb >= 1022 AND ABS((@t * @down) * (@b * @down)) > @one RETURN NULL;
    RETURN @a - @b * @t;
  END
  IF @op = '^'
  BEGIN
    IF @a = 1 OR @b = 0 RETURN 1;
    IF @b = 1 RETURN @a;
    IF @a = 0 RETURN CASE WHEN @b > 0 THEN 0 END;
    IF @a < 0 AND @b <> ROUND(@b, 0, 1) RETURN NULL;
    -- Overflow from the logarithm, a little below ln(max) so that POWER never overflows (a result within 0.2% of the
    -- largest float is NULL: documented); underflow is 0 in SQL Server.
    DECLARE @l float = LOG(ABS(@a));
    IF @l = 0 RETURN POWER(@a, @b); -- a = -1
    IF ABS(@b) > 1e300 RETURN CASE WHEN (@l > 0 AND @b > 0) OR (@l < 0 AND @b < 0) THEN NULL ELSE 0 END;
    IF @b * @l >= 709.78 RETURN NULL;
    RETURN POWER(@a, @b);
  END
  RETURN NULL;
END`,
  ];
}
