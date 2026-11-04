/**
 * Dialect `oracle`, for Oracle Database 23ai and later (it uses SQL's BOOLEAN), and Oracle Spatial:
 * - columns are statically typed; `SqlColumn.sqlType` (the type as `USER_TAB_COLUMNS` names it) picks the view;
 * - text compares in code point order whatever the session's `NLS_COMP` / `NLS_SORT`: the parameter carries
 *   `COLLATE BINARY`, which keeps the column alone on its side, and so its index. Stored text is assumed to be in NFC
 *   (Oracle's `COMPOSE` isn't Unicode's NFC, so the dialect doesn't normalize);
 * - Oracle reads `''` as NULL, so no column holds `''`: a comparison with an empty string is decided when the SQL is
 *   built, exactly as `evaluate` decides it on the served values (see `Dialect.emptyStringIsNull`);
 * - numbers compare as BINARY_DOUBLE, literals bound as text in a fixed format (a JavaScript number outside NUMBER's
 *   range can't be bound as a number, and the session's decimal separator can't change the text);
 * - dates and instants compare as the text the application serves (see {@link oracleValue}): an instant as its UTC
 *   time, truncated to milliseconds, a DATE as a date-time with no zone, never an instant (with `format: "date"`, the
 *   day, its time dropped). Instants compare as UTC text, not as epoch milliseconds: Oracle counts days in the Julian
 *   calendar before 1582, `evaluate` in the proleptic Gregorian one, and the text orders the same in both;
 * - CASEI, ACCENTI, the reading of dates and instants from text, and `%` and `^`, use the functions
 *   {@link oracleFunctions} creates once in the database.
 * - spatial relations through `cql2_relate` (see {@link oracleFunctions}): planar, as CQL2 compares in CRS84 (SRID
 *   4326 is geodetic in Oracle, with geodesic edges), with a tolerance of 1e-10 (Oracle refuses 0). Geometries within
 *   that distance of each other's boundary may be decided either way: the one deviation from GEOS (measured: only
 *   points within 1.4e-14° of a US state's boundary). And a GeometryCollection whose own members meet (overlap or
 *   touch) is read by Oracle with each member's boundary, by GEOS otherwise: for it, the relations but S_INTERSECTS and
 *   S_DISJOINT can differ (measured: 73 of 1,764 answers on such collections; none where the members are apart).
 *   Literals are prepared here (boxes as polygons, rings oriented
 *   as Oracle requires, heights dropped) and bound as numbers (Oracle's GeoJSON functions keep 15 digits).
 * The session's `NLS_CALENDAR` must be GREGORIAN (Oracle's default): it changes the text `TO_CHAR` gives.
 */
import type { Fold } from "../../core/folds.js";
import type { MatrixRelation } from "../../core/relate.js";
import type { ArithmeticOperator, BboxLiteral, Geometry, Position, SpatialLiteral } from "../../core/types.js";
import { accentMarkEntries, caseFoldingEntries } from "../../evaluate/strings.js";
import { COMBINING_CLASSES, COMPOSITIONS } from "./composition.js";
import { quote, type Dialect, type Kind, type PairSide, type SqlColumn, type SqlValue, type View } from "../types.js";

type OraClass =
  | "text" | "char" | "ntext" | "nchar" | "number" | "double" | "boolean" | "date" | "timestamp" | "timestamptz" | "geometry" | "other";

/** A declared type in upper case, without type modifiers, which can sit anywhere: "TIMESTAMP(6) WITH TIME ZONE". */
const bareType = (sqlType: string): string =>
  sqlType.toUpperCase().replace(/\(\s*\d+\s*(?:(?:,\s*-?\d+\s*)|\s+(?:BYTE|CHAR)\s*)?\)/g, "").replace(/\s+/g, " ").trim();

/** What an Oracle column holds, from its declared type, or else from its queryable. */
function oraClass(column: SqlColumn): OraClass {
  if (column.sqlType === undefined) {
    if (typeof column.format === "string" && column.format.startsWith("geometry-")) return "geometry";
    if (column.type === "string") return column.format === "date" ? "date" : column.format === "date-time" ? "timestamptz" : "text";
    if (column.type === "integer" || column.type === "number") return "number";
    return column.type === "boolean" ? "boolean" : "other";
  }
  const t = bareType(column.sqlType);
  if (t === "VARCHAR2" || t === "VARCHAR") return "text";
  if (t === "CHAR") return "char";
  if (t === "NVARCHAR2") return "ntext";
  if (t === "NCHAR") return "nchar";
  if (t === "BINARY_DOUBLE") return "double";
  if (["NUMBER", "FLOAT", "BINARY_FLOAT", "INTEGER", "INT", "SMALLINT", "DECIMAL", "NUMERIC", "REAL", "DOUBLE PRECISION"].includes(t)) {
    return "number";
  }
  if (t === "BOOLEAN") return "boolean";
  if (t === "SDO_GEOMETRY" || t === "MDSYS.SDO_GEOMETRY") return "geometry";
  if (t === "DATE") return "date";
  if (t === "TIMESTAMP") return "timestamp";
  if (t === "TIMESTAMP WITH TIME ZONE" || t === "TIMESTAMP WITH LOCAL TIME ZONE") return "timestamptz";
  return "other";
}

/** A DATE column read as a day: the queryable says `format: "date"`. */
const isDay = (column: SqlColumn): boolean => column.format === "date";

const UTC = (sql: string) => `SYS_EXTRACT_UTC(${sql})`;

/**
 * The text a column's value is served as, for the classes served as strings (a year before 1 with its sign, which
 * `evaluate` reads as no date): NVARCHAR2 and NCHAR as VARCHAR2 (UTF-16 would order by code units).
 */
function oraText(sql: string, cls: OraClass, column: SqlColumn): string | undefined {
  switch (cls) {
    case "text":
    case "char":
      return sql;
    case "ntext":
    case "nchar":
      return `TO_CHAR(${sql})`;
    case "date":
      return isDay(column) ? `LTRIM(TO_CHAR(${sql}, 'SYYYY-MM-DD'))` : `LTRIM(TO_CHAR(${sql}, 'SYYYY-MM-DD"T"HH24:MI:SS'))`;
    case "timestamp":
      return `LTRIM(TO_CHAR(${sql}, 'SYYYY-MM-DD"T"HH24:MI:SS.FF3'))`;
    case "timestamptz":
      return `LTRIM(TO_CHAR(${UTC(sql)}, 'SYYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'))`;
    default:
      return undefined;
  }
}

/**
 * The SQL expression to SELECT for a column, so that the application serves exactly the values the `oracle` dialect
 * compares: numbers as BINARY_DOUBLE; a DATE as `YYYY-MM-DDTHH:MM:SS` (with `format: "date"`, `YYYY-MM-DD`); a
 * TIMESTAMP as `YYYY-MM-DDTHH:MM:SS.sss`; a TIMESTAMP WITH (LOCAL) TIME ZONE as UTC `YYYY-MM-DDTHH:MM:SS.sssZ`;
 * NVARCHAR2 and NCHAR as VARCHAR2. Text (CHAR with its padding), booleans and an SDO_GEOMETRY as they are: read the
 * geometry's ordinates as numbers (the driver gives them exactly), not through SDO_UTIL.TO_GEOJSON (15 significant
 * digits) or TO_WKBGEOMETRY (which can round to the next double). `undefined` for a column
 * type the dialect can't compare (CLOB, RAW, JSON…), which an application shouldn't serve as a queryable.
 */
export function oracleValue(sqlColumn: string, column: SqlColumn): string | undefined {
  const sql = quote(sqlColumn);
  const cls = oraClass(column);
  if (cls === "boolean" || cls === "double") return sql;
  if (cls === "number") return `TO_BINARY_DOUBLE(${sql})`;
  if (cls === "geometry") return sql;
  return oraText(sql, cls, column);
}

const BINARY = " COLLATE BINARY";
/** A number literal as BINARY_DOUBLE: its text in one format, whatever the session's decimal separator. */
const double = (p: string): string => `TO_BINARY_DOUBLE(${p}, '9D9999999999999999EEEE', 'NLS_NUMERIC_CHARACTERS=''.,''')`;
const numberText = (value: SqlValue): SqlValue => (value as number).toExponential();

/** Text compared in code point order: the collation on the parameter's side, so the column keeps its index. */
const textView = (sql: string, extra: Partial<View> = {}): View => ({ sql, cast: BINARY, pair: `${sql}${BINARY}`, ...extra });

function oracleView(sql: string, kind: Kind, column: SqlColumn, fn: (name: string) => string, folds: readonly Fold[]): View | undefined {
  const cls = oraClass(column);
  const text = oraText(sql, cls, column);
  switch (kind) {
    case "text":
      // CHAR against CHAR would compare blank-padded: the pair is its VARCHAR2.
      if (cls === "char") return textView(sql, { pair: `CAST(${sql} AS VARCHAR2(4000 BYTE))${BINARY}` });
      return text ? textView(text) : undefined;
    case "fold":
      return text ? textView(folds.reduce((expression, fold) => `${fn(`cql2_${fold}`)}(${expression})`, text)) : undefined;
    case "number":
      if (cls === "double") return { sql, cast: "", wrap: double, value: numberText };
      return cls === "number" ? { sql: `TO_BINARY_DOUBLE(${sql})`, cast: "", wrap: double, value: numberText } : undefined;
    case "boolean":
      return cls === "boolean" ? { sql, cast: "" } : undefined;
    case "day": {
      if (cls === "date" && isDay(column)) {
        // A year before 1 is served with its sign, which is no day: NULL, as View.finite says.
        const finite = `${sql} >= DATE '0001-01-01'`;
        const day = `TO_CHAR(${sql}, 'YYYY-MM-DD')`;
        return textView(day, { finite, pair: `CASE WHEN ${finite} THEN ${day} END${BINARY}` });
      }
      return cls === "text" || cls === "char" || cls === "ntext" || cls === "nchar" ? textView(`${fn("cql2_day")}(${text})`) : undefined;
    }
    case "instant": {
      // UTC as text, the year in five digits as cql2_instant gives it (an offset can carry year 1 back to year 0).
      if (cls === "timestamptz") {
        const finite = `${UTC(sql)} >= TIMESTAMP '0001-01-01 00:00:00'`;
        const label = `('0' || TO_CHAR(${UTC(sql)}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3'))`;
        return textView(label, { finite, pair: `CASE WHEN ${finite} THEN ${label} END${BINARY}` });
      }
      return cls === "text" || cls === "char" || cls === "ntext" || cls === "nchar" ? textView(`${fn("cql2_instant")}(${text})`) : undefined;
    }
  }
}

/** An instant as `cql2_instant` gives it: UTC, `0YYYY-MM-DDTHH:MM:SS.sss`. */
export function instantLabel(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).padStart(5, "0")}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
}

/**
 * A CQL2 LIKE pattern for Oracle's `LIKE … ESCAPE '\'`, which refuses (ORA-01424) an escape before anything but `%`,
 * `_` or itself: `\x` is `x` for any other `x`, and a lone trailing `\` a backslash.
 */
export function oracleLikePattern(pattern: string): string {
  let out = "";
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c !== "\\") out += c;
    else if (i + 1 === chars.length) out += "\\\\";
    else {
      const next = chars[++i]!;
      out += next === "%" || next === "_" || next === "\\" ? `\\${next}` : next;
    }
  }
  return out;
}

/** A BINARY_DOUBLE result that isn't a finite number as NULL; `r` is written once. */
const finiteOrNull = (r: string): string =>
  `NULLIF(NULLIF(NANVL(${r}, CAST(NULL AS BINARY_DOUBLE)), BINARY_DOUBLE_INFINITY), -BINARY_DOUBLE_INFINITY)`;

/**
 * `a op b` in BINARY_DOUBLE (IEEE, never an error): `+ - * / div` inline; `%` and `^` through `cql2_arithmetic`, which
 * reads each operand once (inline, `%` would repeat them, and Oracle binds each placeholder it reads).
 */
function oracleArithmetic(op: ArithmeticOperator, a: string, b: string, fn: (name: string) => string): string {
  switch (op) {
    case "div":
      return finiteOrNull(`TRUNC(${a} / ${b})`);
    case "%":
    case "^":
      return `${fn("cql2_arithmetic")}('${op}', ${a}, ${b})`;
    default:
      return finiteOrNull(`${a} ${op} ${b}`);
  }
}

// --- Spatial -----------------------------------------------------------------------------------------------------

/** Twice a ring's signed area: positive when it runs counter-clockwise. */
const signedArea = (ring: readonly Position[]): number =>
  ring.reduce((sum, p, i) => (i === 0 ? 0 : sum + (ring[i - 1]![0] * p[1] - p[0] * ring[i - 1]![1])), 0);
const flat = (p: Position): [number, number] => [p[0], p[1]];
/** A polygon's rings in 2D, the exterior counter-clockwise and the holes clockwise, as Oracle requires. */
const orient = (rings: readonly (readonly Position[])[]): [number, number][][] =>
  rings.map((ring, i) => {
    const r = ring.map(flat);
    return (i === 0) === (signedArea(r) > 0) ? r : r.reverse();
  });

/**
 * A literal as GeoJSON Oracle reads as `evaluate` reads the literal: a box as a polygon (across the antimeridian, two),
 * heights dropped (GEOS compares in 2D), rings oriented as Oracle requires (GeoJSON allows either; it changes no
 * answer). Not Oracle's RECTIFY_GEOMETRY, which can merge vertices within the tolerance.
 */
export function oracleGeoJson(literal: SpatialLiteral): object {
  if ("bbox" in literal && !("type" in literal)) {
    const b = (literal as BboxLiteral).bbox;
    const [west, south, east, north] = b.length === 4 ? b : [b[0], b[1], b[3], b[4]];
    const box = (w: number, e: number): [number, number][][] => [[[w, south], [e, south], [e, north], [w, north], [w, south]]];
    return west > east ? { type: "MultiPolygon", coordinates: [box(west, 180), box(-180, east)] } : { type: "Polygon", coordinates: box(west, east) };
  }
  const g = literal as Geometry;
  switch (g.type) {
    case "Point":
      return { type: g.type, coordinates: flat(g.coordinates) };
    case "LineString":
    case "MultiPoint":
      return { type: g.type, coordinates: g.coordinates.map(flat) };
    case "MultiLineString":
      return { type: g.type, coordinates: g.coordinates.map((line) => line.map(flat)) };
    case "Polygon":
      return { type: g.type, coordinates: orient(g.coordinates) };
    case "MultiPolygon":
      return { type: g.type, coordinates: g.coordinates.map(orient) };
    case "GeometryCollection":
      return { type: g.type, geometries: g.geometries.map((member) => oracleGeoJson(member)) };
  }
}

/**
 * A prepared literal (see {@link oracleGeoJson}) in Oracle's own form: `sdo_gtype` (2D), `sdo_elem_info` (offset,
 * element type, interpretation) and the ordinates. Oracle's GeoJSON functions keep 15 significant digits, so the
 * geometry is built from these numbers instead.
 */
function sdoForm(g: { type: string; coordinates?: unknown; geometries?: object[] }): { gtype: number; elem: number[]; ords: number[] } {
  const elem: number[] = [];
  const ords: number[] = [];
  const add = (etype: number, interpretation: number, points: readonly (readonly number[])[]) => {
    elem.push(ords.length + 1, etype, interpretation);
    for (const p of points) ords.push(p[0]!, p[1]!);
  };
  const polygon = (rings: readonly (readonly (readonly number[])[])[]) => rings.forEach((ring, i) => add(i === 0 ? 1003 : 2003, 1, ring));
  const put = (m: { type: string; coordinates?: unknown; geometries?: object[] }): number => {
    const c = m.coordinates as never;
    switch (m.type) {
      case "Point": add(1, 1, [c]); return 1;
      case "LineString": add(2, 1, c); return 2;
      case "Polygon": polygon(c); return 3;
      case "MultiPoint": add(1, (c as unknown[]).length, c); return 5;
      case "MultiLineString": (c as number[][][]).forEach((line) => add(2, 1, line)); return 6;
      case "MultiPolygon": (c as number[][][][]).forEach(polygon); return 7;
      default: (m.geometries as { type: string }[]).forEach(put); return 4;
    }
  };
  return { gtype: 2000 + put(g), elem, ords };
}

/** The longest text bound as one parameter: Oracle refuses a bound text over 4,000 bytes in SQL (ORA-01460). */
const CHUNK = 3900;

/**
 * The literal as an SDO_GEOMETRY in `srid` (NULL: planar), built once per query (a scalar subquery) by cql2_geometry
 * from its numbers as text: the ordinates in exponent notation, read with an explicit format whatever the session.
 * A long text is bound as several parameters, each read once.
 */
function literalSql(literal: SpatialLiteral, param: (value: SqlValue) => string, fn: (name: string) => string, srid: number | null): string {
  const { gtype, elem, ords } = sdoForm(oracleGeoJson(literal) as never);
  const text = [gtype, elem.length, ...elem, ...ords.map((x) => x.toExponential())].join(" ");
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK)); // ASCII: one byte a character
  const clob = chunks.map((chunk) => `TO_CLOB(${param(chunk)})`).join(" || ");
  return `(SELECT ${fn("cql2_geometry")}(${clob}, ${srid ?? "NULL"}) FROM dual)`;
}

/** `relation(a, b)` through cql2_relate: 1, 0, or NULL for a NULL geometry. */
const relateSql = (relation: "s_intersects" | MatrixRelation, a: string, b: string, fn: (name: string) => string): string =>
  `${fn("cql2_relate")}('${relation}', ${a}, ${b}) = 1`;

/**
 * `relation(column, literal)`; with `spatialIndex`, and only where the leaf isn't negated (see Dialect.intersects),
 * the candidates first, through the planar index on `cql2_planar(column)`: `SDO_FILTER` compares boxes, and every
 * relation but S_DISJOINT (written as NOT S_INTERSECTS) holds only where the geometries meet, so the prefilter is
 * exact. Not a geodetic (SRID 4326) index: it reads edges as geodesics, and loses planar candidates (measured: long
 * lines across US states, a box 358° wide).
 */
function oracleSpatial(
  relation: "s_intersects" | MatrixRelation, sql: string, column: SqlColumn, literal: SpatialLiteral,
  param: (value: SqlValue) => string, positive: boolean, fn: (name: string) => string,
): string | undefined {
  if (oraClass(column) !== "geometry") return undefined;
  if (column.spatialIndex !== true || !positive) return relateSql(relation, sql, literalSql(literal, param, fn, null), fn);
  const filter = `SDO_FILTER(${fn("cql2_planar")}(${sql}), ${literalSql(literal, param, fn, null)}) = 'TRUE'`;
  return `(${filter} AND ${relateSql(relation, sql, literalSql(literal, param, fn, null), fn)})`;
}

/** A relation of two geometries, each a column or a literal (Property-Property Comparisons). */
function oraclePair(relation: "s_intersects" | MatrixRelation, a: PairSide, b: PairSide, param: (value: SqlValue) => string, fn: (name: string) => string): string | undefined {
  const side = (s: PairSide) => ("literal" in s ? literalSql(s.literal, param, fn, null) : oraClass(s.column) === "geometry" ? s.sql : undefined);
  const [ga, gb] = [side(a), side(b)];
  return ga === undefined || gb === undefined ? undefined : relateSql(relation, ga, gb, fn);
}

/** A string as the hex of its UTF-8 bytes: the statements stay ASCII, whatever the client's character set. */
const hex = (text: string): string =>
  [...text].map((ch) => {
    const c = ch.codePointAt(0)!;
    const bytes = c < 0x80 ? [c]
      : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 63)]
      : c < 0x10000 ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)]
      : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
    return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  }).join("");

/** The combining classes, one row per code point. */
const combiningRows = (): [number, number][] =>
  COMBINING_CLASSES.split(";").flatMap((e) => {
    const [start, count, ccc] = e.split(",");
    return Array.from({ length: parseInt(count!, 16) }, (_, i): [number, number] => [parseInt(start!, 16) + i, Number(ccc)]);
  });

/** `INSERT … SELECT` of the rows, each value given as hex (see {@link hex}). */
const insertHex = (table: string, columns: readonly string[], rows: readonly (readonly string[])[]): string => {
  const values = rows.map((row) => `(${row.map((v) => `'${hex(v)}'`).join(", ")})`).join(",\n");
  const names = columns.map((_, i) => `h${i}`);
  return `INSERT INTO ${table} (${columns.join(", ")})
SELECT ${names.map((h) => `UTL_RAW.CAST_TO_VARCHAR2(HEXTORAW(${h}))`).join(", ")} FROM (VALUES
${values}) v (${names.join(", ")})`;
};

/**
 * The statements that create, in `schema` (or the connection's own schema), what the `oracle` dialect calls: run them
 * once, in order, as a user who may create tables and functions there; then commit (the last statement does). An
 * array, since Oracle's drivers run one statement at a time; joined with lines holding `/`, they make a SQL*Plus
 * script. Safe to run again. Needs Oracle 23ai or later and the database character set AL32UTF8. They create (or
 * replace):
 * - `cql2_casefold`: Unicode's full case folding (CaseFolding 15.0.0, statuses C and F), the package's own table;
 * - `cql2_accent_marks`: the nonspacing marks ACCENTI removes (Unicode 15.0.0, category Mn, except the Japanese voicing
 *   marks), the package's own table;
 * - `cql2_compose` and `cql2_combining`: Unicode's primary composites and canonical combining classes (Unicode
 *   15.0.0), the package's own tables, for the NFC that CASEI and ACCENTI end with;
 * - the package `cql2_support`, which holds the tables in memory, once per session (replacing it makes sessions that
 *   used it fail once, with ORA-04068, as Oracle does for any package with state);
 * - `cql2_casei(t)`: a string's canonical caseless form, as `evaluate` computes it (NFD, fold, NFC);
 * - `cql2_accenti(t)`: a string without accents, as `evaluate` computes it (NFD, the marks removed, NFC).
 *   Both normalize with the tables, not with Oracle alone: its DECOMPOSE leaves marks above U+FFFF out of canonical
 *   order, and its COMPOSE never composes across a mark. Characters added after Unicode 15.0.0 are decomposed by the
 *   database's own Unicode version, so they can compare differently, as between the other engines;
 * - `cql2_day(t)`: a `YYYY-MM-DD` text that exists (proleptic Gregorian, years 0001–9999), else NULL;
 * - `cql2_instant(t)`: an ISO 8601 date-time with `Z` or an offset that exists, as UTC text truncated to milliseconds
 *   (`0YYYY-MM-DDTHH:MM:SS.sss`, the year in five digits), else NULL. The same strict rules as `evaluate`;
 * - `cql2_arithmetic(op, a, b)`: `a % b` and `a ^ b` in BINARY_DOUBLE, exactly as `evaluate` computes them, NULL for a
 *   result that isn't a finite number;
 * - `cql2_geometry(t, srid)`: an SDO_GEOMETRY from the numbers the dialect writes, exactly (SDO_UTIL.FROM_GEOJSON keeps
 *   15 significant digits);
 * - `cql2_planar(g)`: the geometry with SRID NULL, for a planar spatial index (see `SqlColumn.spatialIndex`; replacing
 *   it leaves such an index valid and in use, measured);
 * - `cql2_relate(relation, a, b)`: a spatial relation of two geometries, planar (their SRID set to NULL), with a
 *   tolerance of 1e-10: 1, 0, or NULL for a NULL geometry. One SDO_GEOM.RELATE(…, 'DETERMINE', …) gives the mask; for
 *   S_OVERLAPS and S_CROSSES the dimensions decide, and for two lines the dimension of their intersection.
 *
 * A folded string, or an NVARCHAR2 value as VARCHAR2, can't be longer than 4,000 bytes (with MAX_STRING_SIZE
 * STANDARD): a longer one makes the query fail (ORA-06502, ORA-01401), it never gives a wrong answer. A value made only
 * of accent marks is `''` under ACCENTI in `evaluate`, and NULL in Oracle, which has no `''`.
 */
export function oracleFunctions(schema?: string): string[] {
  const s = schema === undefined ? "" : `${quote(schema)}.`;
  const digits = "'0123456789', '9999999999'";
  return [
    `CREATE TABLE IF NOT EXISTS ${s}cql2_casefold (from_char VARCHAR2(16 BYTE) PRIMARY KEY, to_text VARCHAR2(64 BYTE) NOT NULL)`,
    `TRUNCATE TABLE ${s}cql2_casefold`,
    insertHex(`${s}cql2_casefold`, ["from_char", "to_text"], caseFoldingEntries().map(([from, to]) => [String.fromCodePoint(from), to])),
    `CREATE TABLE IF NOT EXISTS ${s}cql2_accent_marks (mark VARCHAR2(16 BYTE) PRIMARY KEY)`,
    `TRUNCATE TABLE ${s}cql2_accent_marks`,
    insertHex(`${s}cql2_accent_marks`, ["mark"], accentMarkEntries().map((code) => [String.fromCodePoint(code)])),
    `CREATE TABLE IF NOT EXISTS ${s}cql2_compose (starter VARCHAR2(16 BYTE), mark VARCHAR2(16 BYTE), composite VARCHAR2(16 BYTE) NOT NULL, PRIMARY KEY (starter, mark))`,
    `TRUNCATE TABLE ${s}cql2_compose`,
    insertHex(`${s}cql2_compose`, ["starter", "mark", "composite"], COMPOSITIONS.split(";").map((e) => e.split(",").map((h) => String.fromCodePoint(parseInt(h, 16))))),
    `CREATE TABLE IF NOT EXISTS ${s}cql2_combining (code VARCHAR2(16 BYTE) PRIMARY KEY, class NUMBER(3) NOT NULL)`,
    `TRUNCATE TABLE ${s}cql2_combining`,
    `INSERT INTO ${s}cql2_combining (code, class)
SELECT UTL_RAW.CAST_TO_VARCHAR2(HEXTORAW(h)), c FROM (VALUES
${combiningRows().map(([code, ccc]) => `('${hex(String.fromCodePoint(code))}', ${ccc})`).join(",\n")}) v (h, c)`,
    `CREATE OR REPLACE PACKAGE ${s}cql2_support AUTHID DEFINER AS
  -- ogc-cql2: what the oracle dialect's functions share. Keys are the hex of a character's UTF-8 bytes, so that no
  -- session's NLS_SORT changes how they are told apart.
  TYPE char_map IS TABLE OF VARCHAR2(64 BYTE) INDEX BY VARCHAR2(32);
  TYPE class_map IS TABLE OF PLS_INTEGER INDEX BY VARCHAR2(16);
  FUNCTION fold(t VARCHAR2, casei BOOLEAN) RETURN VARCHAR2;
  FUNCTION real_day(y PLS_INTEGER, m PLS_INTEGER, d PLS_INTEGER) RETURN BOOLEAN;
END;`,
    `CREATE OR REPLACE PACKAGE BODY ${s}cql2_support AS
  folds char_map;
  marks char_map;
  composites char_map; -- by the starter's key, '.', the mark's key
  classes class_map;
  loaded BOOLEAN := FALSE;

  FUNCTION key(ch VARCHAR2) RETURN VARCHAR2 IS
  BEGIN
    RETURN RAWTOHEX(UTL_RAW.CAST_TO_RAW(ch));
  END;

  PROCEDURE load IS
  BEGIN
    FOR r IN (SELECT from_char, to_text FROM ${s}cql2_casefold) LOOP
      folds(RAWTOHEX(UTL_RAW.CAST_TO_RAW(r.from_char))) := r.to_text;
    END LOOP;
    FOR r IN (SELECT mark FROM ${s}cql2_accent_marks) LOOP
      marks(RAWTOHEX(UTL_RAW.CAST_TO_RAW(r.mark))) := r.mark;
    END LOOP;
    FOR r IN (SELECT starter, mark, composite FROM ${s}cql2_compose) LOOP
      composites(key(r.starter) || '.' || key(r.mark)) := r.composite;
    END LOOP;
    FOR r IN (SELECT code, class FROM ${s}cql2_combining) LOOP
      classes(key(r.code)) := r.class;
    END LOOP;
    loaded := TRUE;
  END;

  -- A BMP code point of a three-byte key (Hangul's are), else -1.
  FUNCTION bmp(k VARCHAR2) RETURN PLS_INTEGER IS
  BEGIN
    IF LENGTH(k) <> 6 THEN RETURN -1; END IF;
    RETURN MOD(TO_NUMBER(SUBSTR(k, 1, 2), 'XX'), 16) * 4096 + MOD(TO_NUMBER(SUBSTR(k, 3, 2), 'XX'), 64) * 64
      + MOD(TO_NUMBER(SUBSTR(k, 5, 2), 'XX'), 64);
  END;

  FUNCTION bmp_char(c PLS_INTEGER) RETURN VARCHAR2 IS
  BEGIN
    RETURN UTL_RAW.CAST_TO_VARCHAR2(HEXTORAW(TO_CHAR(224 + TRUNC(c / 4096), 'FMXX') || TO_CHAR(128 + MOD(TRUNC(c / 64), 64), 'FMXX')
      || TO_CHAR(128 + MOD(c, 64), 'FMXX')));
  END;

  -- The primary composite of a starter and the next character, or NULL: the table, or Hangul's arithmetic.
  FUNCTION composite(starter VARCHAR2, sk VARCHAR2, k VARCHAR2) RETURN VARCHAR2 IS
    s PLS_INTEGER;
    c PLS_INTEGER;
  BEGIN
    IF composites.EXISTS(sk || '.' || k) THEN RETURN composites(sk || '.' || k); END IF;
    s := bmp(sk);
    IF s < 4352 THEN RETURN NULL; END IF;
    c := bmp(k);
    IF s BETWEEN 4352 AND 4370 AND c BETWEEN 4449 AND 4469 THEN -- a leading and a vowel jamo: an LV syllable
      RETURN bmp_char(44032 + ((s - 4352) * 21 + (c - 4449)) * 28);
    ELSIF s BETWEEN 44032 AND 55203 AND MOD(s - 44032, 28) = 0 AND c BETWEEN 4520 AND 4546 THEN -- LV and a trailing jamo
      RETURN bmp_char(s + c - 4519);
    END IF;
    RETURN NULL;
  END;

  -- Canonical ordering: each run of characters with a combining class sorted by class, stably. Oracle's DECOMPOSE
  -- leaves marks above U+FFFF out of order.
  FUNCTION canonical_order(d VARCHAR2) RETURN VARCHAR2 IS
    TYPE text_list IS TABLE OF VARCHAR2(16) INDEX BY PLS_INTEGER;
    TYPE class_list IS TABLE OF PLS_INTEGER INDEX BY PLS_INTEGER;
    chars text_list;
    ccs class_list;
    n PLS_INTEGER := 0;
    j PLS_INTEGER;
    ch VARCHAR2(16);
    k VARCHAR2(32);
    cc PLS_INTEGER;
    r VARCHAR2(32767);
  BEGIN
    FOR i IN 1 .. NVL(LENGTH(d), 0) LOOP
      ch := SUBSTR(d, i, 1);
      k := key(ch);
      cc := CASE WHEN classes.EXISTS(k) THEN classes(k) ELSE 0 END;
      n := n + 1;
      j := n;
      WHILE cc > 0 AND j > 1 AND ccs(j - 1) > cc LOOP
        chars(j) := chars(j - 1);
        ccs(j) := ccs(j - 1);
        j := j - 1;
      END LOOP;
      chars(j) := ch;
      ccs(j) := cc;
    END LOOP;
    FOR i IN 1 .. n LOOP r := r || chars(i); END LOOP;
    RETURN r;
  END;

  -- Unicode's canonical composition (UAX #15) of a string in canonical order: a character composes with the last
  -- starter unless one between them has class 0, or a class not lower than its own.
  FUNCTION canonical_compose(d VARCHAR2) RETURN VARCHAR2 IS
    r VARCHAR2(32767);
    starter VARCHAR2(16);
    sk VARCHAR2(32);
    tail VARCHAR2(32767);
    last_class PLS_INTEGER := 256; -- a string that begins with marks: they have no starter
    ch VARCHAR2(16);
    k VARCHAR2(32);
    cc PLS_INTEGER;
    c VARCHAR2(16);
  BEGIN
    FOR i IN 1 .. NVL(LENGTH(d), 0) LOOP
      ch := SUBSTR(d, i, 1);
      k := key(ch);
      cc := CASE WHEN classes.EXISTS(k) THEN classes(k) ELSE 0 END;
      c := CASE WHEN starter IS NOT NULL AND (last_class < cc OR last_class = 0) THEN composite(starter, sk, k) END;
      IF c IS NOT NULL THEN
        starter := c;
        sk := key(c);
      ELSIF cc = 0 THEN
        r := r || starter || tail;
        starter := ch;
        sk := k;
        tail := NULL;
        last_class := 0;
      ELSE
        tail := tail || ch;
        last_class := cc;
      END IF;
    END LOOP;
    RETURN r || starter || tail;
  END;

  FUNCTION fold(t VARCHAR2, casei BOOLEAN) RETURN VARCHAR2 IS
    d VARCHAR2(32767);
    r VARCHAR2(32767);
    ch VARCHAR2(16);
    k VARCHAR2(16);
  BEGIN
    IF t IS NULL THEN RETURN NULL; END IF;
    IF LENGTHB(t) = LENGTH(t) THEN -- ASCII
      RETURN CASE WHEN casei THEN TRANSLATE(t, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') ELSE t END;
    END IF;
    IF NOT loaded THEN load; END IF;
    d := canonical_order(DECOMPOSE(t, 'CANONICAL'));
    FOR i IN 1 .. LENGTH(d) LOOP
      ch := SUBSTR(d, i, 1);
      k := RAWTOHEX(UTL_RAW.CAST_TO_RAW(ch));
      IF casei THEN
        r := r || CASE WHEN folds.EXISTS(k) THEN folds(k) ELSE ch END;
      ELSIF NOT marks.EXISTS(k) THEN
        r := r || ch;
      END IF;
    END LOOP;
    -- NFC again: folding can give characters that decompose, or a starter where a mark was (U+0345); removing marks
    -- can leave two others out of order.
    RETURN canonical_compose(canonical_order(CASE WHEN casei THEN DECOMPOSE(r, 'CANONICAL') ELSE r END));
  END;

  FUNCTION real_day(y PLS_INTEGER, m PLS_INTEGER, d PLS_INTEGER) RETURN BOOLEAN IS
  BEGIN
    IF y < 1 OR m < 1 OR m > 12 OR d < 1 THEN RETURN FALSE; END IF;
    RETURN d <= CASE
      WHEN m = 2 THEN CASE WHEN (MOD(y, 4) = 0 AND MOD(y, 100) <> 0) OR MOD(y, 400) = 0 THEN 29 ELSE 28 END
      WHEN m IN (4, 6, 9, 11) THEN 30
      ELSE 31
    END;
  END;
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_casei(t VARCHAR2) RETURN VARCHAR2 DETERMINISTIC IS
  PRAGMA UDF;
BEGIN
  RETURN ${s}cql2_support.fold(t, TRUE);
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_accenti(t VARCHAR2) RETURN VARCHAR2 DETERMINISTIC IS
  PRAGMA UDF;
BEGIN
  RETURN ${s}cql2_support.fold(t, FALSE);
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_day(t VARCHAR2) RETURN VARCHAR2 DETERMINISTIC IS
  PRAGMA UDF;
BEGIN
  IF LENGTH(t) = 10 AND TRANSLATE(t, ${digits}) = '9999-99-99'
     AND ${s}cql2_support.real_day(TO_NUMBER(SUBSTR(t, 1, 4)), TO_NUMBER(SUBSTR(t, 6, 2)), TO_NUMBER(SUBSTR(t, 9, 2))) THEN
    RETURN t;
  END IF;
  RETURN NULL;
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_instant(t VARCHAR2) RETURN VARCHAR2 DETERMINISTIC IS
  PRAGMA UDF;
  n PLS_INTEGER := LENGTH(t);
  pos PLS_INTEGER := 17;
  y NUMBER; mo NUMBER; d NUMBER; h NUMBER; mi NUMBER; sec NUMBER := 0; ms NUMBER := 0;
  sgn NUMBER := 0; oh NUMBER := 0; om NUMBER := 0;
  rest VARCHAR2(32767);
  yy NUMBER; era NUMBER; yoe NUMBER; doy NUMBER; doe NUMBER; mp NUMBER; z NUMBER; total NUMBER; rem NUMBER;
BEGIN
  -- YYYY-MM-DDTHH:MM[:SS[.fraction]](Z|+HH:MM|-HH:MM), T and Z in either case, as evaluate reads it.
  IF n IS NULL OR n < 17 OR TRANSLATE(SUBSTR(t, 1, 10) || SUBSTR(t, 12, 5), ${digits}) <> '9999-99-9999:99'
     OR SUBSTR(t, 11, 1) NOT IN ('T', 't') THEN
    RETURN NULL;
  END IF;
  IF SUBSTR(t, 17, 1) = ':' THEN
    IF TRANSLATE(SUBSTR(t, 18, 2), ${digits}) <> '99' OR n < 19 THEN RETURN NULL; END IF;
    sec := TO_NUMBER(SUBSTR(t, 18, 2));
    pos := 20;
    IF SUBSTR(t, 20, 1) = '.' THEN
      pos := 21;
      WHILE pos <= n AND INSTR('0123456789', SUBSTR(t, pos, 1)) > 0 LOOP pos := pos + 1; END LOOP;
      IF pos = 21 THEN RETURN NULL; END IF;
      ms := TO_NUMBER(RPAD(SUBSTR(t, 21, LEAST(pos - 21, 3)), 3, '0'));
    END IF;
  END IF;
  rest := SUBSTR(t, pos);
  IF rest IN ('Z', 'z') THEN
    NULL;
  ELSIF LENGTH(rest) = 6 AND SUBSTR(rest, 1, 1) IN ('+', '-') AND TRANSLATE(SUBSTR(rest, 2), ${digits}) = '99:99' THEN
    sgn := CASE SUBSTR(rest, 1, 1) WHEN '-' THEN -1 ELSE 1 END;
    oh := TO_NUMBER(SUBSTR(rest, 2, 2));
    om := TO_NUMBER(SUBSTR(rest, 5, 2));
  ELSE
    RETURN NULL;
  END IF;
  y := TO_NUMBER(SUBSTR(t, 1, 4)); mo := TO_NUMBER(SUBSTR(t, 6, 2)); d := TO_NUMBER(SUBSTR(t, 9, 2));
  h := TO_NUMBER(SUBSTR(t, 12, 2)); mi := TO_NUMBER(SUBSTR(t, 15, 2));
  IF NOT ${s}cql2_support.real_day(y, mo, d) OR h > 23 OR mi > 59 OR sec > 59 OR oh > 23 OR om > 59 THEN
    RETURN NULL;
  END IF;
  -- Days since 1970-01-01 in the proleptic Gregorian calendar (Oracle's own dates are Julian before 1582), and back.
  yy := y - CASE WHEN mo <= 2 THEN 1 ELSE 0 END;
  era := FLOOR(yy / 400);
  yoe := yy - era * 400;
  doy := FLOOR((153 * MOD(mo + 9, 12) + 2) / 5) + d - 1;
  doe := yoe * 365 + FLOOR(yoe / 4) - FLOOR(yoe / 100) + doy;
  total := (era * 146097 + doe - 719468) * 86400000 + h * 3600000 + mi * 60000 + sec * 1000 + ms
           - sgn * (oh * 60 + om) * 60000;
  z := FLOOR(total / 86400000);
  rem := total - z * 86400000;
  z := z + 719468;
  era := FLOOR(z / 146097);
  doe := z - era * 146097;
  yoe := FLOOR((doe - FLOOR(doe / 1460) + FLOOR(doe / 36524) - FLOOR(doe / 146096)) / 365);
  doy := doe - (365 * yoe + FLOOR(yoe / 4) - FLOOR(yoe / 100));
  mp := FLOOR((5 * doy + 2) / 153);
  d := doy - FLOOR((153 * mp + 2) / 5) + 1;
  mo := CASE WHEN mp < 10 THEN mp + 3 ELSE mp - 9 END;
  y := yoe + era * 400 + CASE WHEN mo <= 2 THEN 1 ELSE 0 END;
  RETURN LPAD(TO_CHAR(y), 5, '0') || '-' || LPAD(TO_CHAR(mo), 2, '0') || '-' || LPAD(TO_CHAR(d), 2, '0')
    || 'T' || LPAD(TO_CHAR(FLOOR(rem / 3600000)), 2, '0') || ':' || LPAD(TO_CHAR(MOD(FLOOR(rem / 60000), 60)), 2, '0')
    || ':' || LPAD(TO_CHAR(MOD(FLOOR(rem / 1000), 60)), 2, '0') || '.' || LPAD(TO_CHAR(MOD(rem, 1000)), 3, '0');
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_arithmetic(op VARCHAR2, a BINARY_DOUBLE, b BINARY_DOUBLE) RETURN BINARY_DOUBLE DETERMINISTIC IS
  PRAGMA UDF;
  r BINARY_DOUBLE;
BEGIN
  IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
  IF op = '%' THEN
    r := a - b * TRUNC(a / b);
  ELSIF op = '^' THEN
    IF a = 1 THEN
      r := 1;
    ELSIF a < 0 AND b = TRUNC(b) THEN -- Oracle's POWER gives NaN for some odd exponents of a negative base
      r := POWER(-a, b);
      IF MOD(b, 2) <> 0 THEN r := -r; END IF;
    ELSE
      r := POWER(a, b);
    END IF;
  END IF;
  IF r IS NAN OR r IS INFINITE THEN RETURN NULL; END IF;
  RETURN r;
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_geometry(t CLOB, srid NUMBER) RETURN SDO_GEOMETRY DETERMINISTIC IS
  -- "gtype n e1 ... en x1 y1 x2 y2 ...": the elem_info's n numbers, then the ordinates in exponent notation.
  g SDO_GEOMETRY := SDO_GEOMETRY(NULL, srid, NULL, SDO_ELEM_INFO_ARRAY(), SDO_ORDINATE_ARRAY());
  len PLS_INTEGER := DBMS_LOB.GETLENGTH(t);
  p PLS_INTEGER := 1;
  n PLS_INTEGER;
  i PLS_INTEGER := 0;
  FUNCTION token RETURN VARCHAR2 IS
    q PLS_INTEGER := DBMS_LOB.INSTR(t, ' ', p);
    r VARCHAR2(64);
  BEGIN
    IF q = 0 THEN q := len + 1; END IF;
    r := DBMS_LOB.SUBSTR(t, q - p, p);
    p := q + 1;
    RETURN r;
  END;
BEGIN
  g.sdo_gtype := TO_NUMBER(token);
  n := TO_NUMBER(token);
  g.sdo_elem_info.EXTEND(n);
  FOR k IN 1 .. n LOOP g.sdo_elem_info(k) := TO_NUMBER(token); END LOOP;
  WHILE p <= len LOOP
    i := i + 1;
    g.sdo_ordinates.EXTEND;
    g.sdo_ordinates(i) := TO_NUMBER(token, '9D99999999999999999EEEE', 'NLS_NUMERIC_CHARACTERS=''.,''');
  END LOOP;
  RETURN g;
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_planar(g SDO_GEOMETRY) RETURN SDO_GEOMETRY DETERMINISTIC PARALLEL_ENABLE IS
  x SDO_GEOMETRY := g;
BEGIN
  IF x IS NOT NULL THEN x.sdo_srid := NULL; END IF;
  RETURN x;
END;`,
    `CREATE OR REPLACE FUNCTION ${s}cql2_relate(relation VARCHAR2, a SDO_GEOMETRY, b SDO_GEOMETRY) RETURN NUMBER DETERMINISTIC IS
  x SDO_GEOMETRY := a;
  y SDO_GEOMETRY := b;
  m VARCHAR2(32);
  da PLS_INTEGER;
  db PLS_INTEGER;
  -- A geometry's dimension: 0 points, 1 lines, 2 areas; a collection's, its highest.
  FUNCTION dim(g SDO_GEOMETRY) RETURN PLS_INTEGER IS
    t PLS_INTEGER := MOD(g.sdo_gtype, 10);
    d PLS_INTEGER := -1;
    e PLS_INTEGER;
  BEGIN
    IF t IN (1, 5) THEN RETURN 0; ELSIF t IN (2, 6) THEN RETURN 1; ELSIF t IN (3, 7) THEN RETURN 2; END IF;
    FOR i IN 0 .. g.sdo_elem_info.COUNT / 3 - 1 LOOP
      e := MOD(g.sdo_elem_info(i * 3 + 2), 1000);
      d := GREATEST(d, CASE WHEN e = 1 THEN 0 WHEN e IN (2, 4) THEN 1 WHEN e IN (3, 5) THEN 2 ELSE -1 END);
    END LOOP;
    RETURN d;
  END;
BEGIN
  IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
  -- Planar, as CQL2 compares in CRS84: SRID 4326 is geodetic in Oracle.
  x.sdo_srid := NULL;
  y.sdo_srid := NULL;
  m := SDO_GEOM.RELATE(x, 'DETERMINE', y, 1e-10);
  IF relation = 's_intersects' THEN RETURN CASE WHEN m = 'DISJOINT' THEN 0 ELSE 1 END; END IF;
  IF relation = 's_equals' THEN RETURN CASE WHEN m = 'EQUAL' THEN 1 ELSE 0 END; END IF;
  IF relation = 's_touches' THEN RETURN CASE WHEN m IN ('TOUCH', 'ON') THEN 1 ELSE 0 END; END IF;
  IF relation = 's_within' THEN RETURN CASE WHEN m IN ('INSIDE', 'COVEREDBY', 'EQUAL') THEN 1 ELSE 0 END; END IF;
  IF relation = 's_contains' THEN RETURN CASE WHEN m IN ('CONTAINS', 'COVERS', 'EQUAL') THEN 1 ELSE 0 END; END IF;
  -- S_OVERLAPS and S_CROSSES: the interiors meet and neither covers the other; then the dimensions decide, and for
  -- two lines the dimension of what they share (a line: they overlap; points: they cross).
  IF m NOT IN ('OVERLAPBDYDISJOINT', 'OVERLAPBDYINTERSECT') THEN RETURN 0; END IF;
  da := dim(x);
  db := dim(y);
  IF da = 1 AND db = 1 THEN
    da := dim(SDO_GEOM.SDO_INTERSECTION(x, y, 1e-10));
    RETURN CASE WHEN (relation = 's_overlaps') = (da = 1) THEN 1 ELSE 0 END;
  END IF;
  IF relation = 's_overlaps' THEN RETURN CASE WHEN da = db THEN 1 ELSE 0 END; END IF;
  RETURN CASE WHEN da <> db THEN 1 ELSE 0 END;
END;`,
    "COMMIT",
  ];
}

export const oracle: Dialect = {
  placeholder: (n) => `:${n}`,
  number: (value, param) => double(param(numberText(value))),
  arithmetic: oracleArithmetic,
  true: "TRUE",
  false: "FALSE",
  never: "CAST(NULL AS BOOLEAN)",
  emptyStringIsNull: true,
  boolean: (value) => value,
  instant: instantLabel,
  view: oracleView,
  like: (v, pattern, param) => `${v.sql} LIKE ${param(oracleLikePattern(pattern))}${BINARY} ESCAPE '\\'`,
  intersects: (sql, column, literal, param, positive, fn) => oracleSpatial("s_intersects", sql, column, literal, param, positive, fn),
  relate: oracleSpatial,
  spatialPair: oraclePair,
};
