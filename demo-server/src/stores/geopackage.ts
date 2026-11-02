/**
 * Collections read from a GeoPackage file (OGC 12-128r19, version 1.4): one per table it lists, filtered in the
 * database with `ogc-cql2/sql`.
 *
 * What GeoPackage defines, and how it's used:
 * - `gpkg_contents` lists the user tables (Req 14); rows with `data_type` `features` (with geometry) or `attributes`
 *   (without, Req 118) are served. `identifier` is the title;
 * - the id is the INTEGER primary key that is the `rowid` alias (Req 29, 119), or, for a view, its first INTEGER
 *   column (Req 151);
 * - columns are declared with Table 1's types (Req 5), which give the queryables. BOOLEAN is INTEGER 0 / 1, served as
 *   `false` / `true`;
 * - a feature table's geometry column is registered in `gpkg_geometry_columns` with its `srs_id` (Req 22); values are
 *   GeoPackageBinary, decoded to GeoJSON. GeoJSON is WGS 84 longitude, latitude, so a table in another SRS is served
 *   without geometry, and that's reported. Spatial filters run in the database, through `cql2_intersects`, with the
 *   R-tree index (the `gpkg_rtree_index` extension) when the file registers one.
 *
 * The file is opened read-only.
 */
import { DatabaseSync } from "node:sqlite";
import type { Cql2Filter } from "ogc-cql2";
import { sqlConformance, sqliteFunctions, toSql, type SqlColumn } from "ogc-cql2/sql";
import { decodeGeoPackageBinary, type Geometry } from "../geopackage/binary.ts";
import { type CollectionDescription, type Feature, type Queryable, type Store } from "./types.ts";

export interface GeoPackageSource {
  readonly file: string;
  /** Only these tables, by `table_name`; default all `features` and `attributes` tables. */
  readonly tables?: readonly string[];
  /** Put before each table name to make its collection id, so that ids stay unique across sources. */
  readonly prefix?: string;
}

/** `PRAGMA application_id` of a GeoPackage: "GPKG" (1.2 and later), "GP10" and "GP11" (1.0, 1.1). */
const APPLICATION_IDS = new Map([[0x47504b47, "GPKG"], [0x47503130, "GP10"], [0x47503131, "GP11"]]);

/** GeoPackage Table 1 (Req 5) → queryable. `undefined`: not queryable (BLOB). */
function queryableOf(declared: string): Queryable | undefined | "unknown" {
  const type = declared.toUpperCase().replace(/\s*\(.*\)$/, "");
  switch (type) {
    case "BOOLEAN":
      return { type: "boolean" };
    case "TINYINT":
    case "SMALLINT":
    case "MEDIUMINT":
    case "INT":
    case "INTEGER":
      return { type: "integer" };
    case "FLOAT":
    case "DOUBLE":
    case "REAL":
      return { type: "number" };
    case "TEXT":
      return { type: "string" };
    case "DATE":
      return { type: "string", format: "date" };
    case "DATETIME":
      return { type: "string", format: "date-time" };
    case "BLOB":
      return undefined;
    default:
      return "unknown";
  }
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const ID = /^[A-Za-z0-9_-]+$/;

interface Row {
  [column: string]: unknown;
}

/** Opens the GeoPackage and makes one store per served table. Throws if the file can't be served at all. */
/** Loads SpatiaLite (mod_spatialite) from CQL2_SPATIALITE or the usual places; whether it loaded. */
export function loadSpatialite(db: DatabaseSync): boolean {
  for (const path of [process.env.CQL2_SPATIALITE, "/opt/homebrew/lib/mod_spatialite", "/usr/local/lib/mod_spatialite", "/usr/lib/x86_64-linux-gnu/mod_spatialite", "mod_spatialite"]) {
    if (!path) continue;
    try {
      db.loadExtension(path);
      return true;
    } catch {
      // the next place
    }
  }
  return false;
}

export function openGeoPackage(source: GeoPackageSource): { stores: { id: string; store: Store }[]; warnings: string[] } {
  const db = new DatabaseSync(source.file, { readOnly: true, allowExtension: true });
  for (const [name, fn] of Object.entries(sqliteFunctions)) db.function(name, { deterministic: true }, fn as never);
  // SpatiaLite, when it is installed, answers the Spatial Functions class (S_WITHIN, S_TOUCHES, …).
  const spatialite = loadSpatialite(db);
  const all = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as Row[];

  const applicationId = Number(all("PRAGMA application_id")[0]!.application_id);
  const hasContents = all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gpkg_contents'").length > 0;
  if (!APPLICATION_IDS.has(applicationId) || !hasContents) {
    db.close();
    throw new Error(`${source.file} is not a GeoPackage (no "GPKG" application id or no gpkg_contents table).`);
  }

  const contents = all(
    "SELECT table_name, data_type, identifier, description FROM gpkg_contents WHERE lower(data_type) IN ('features', 'attributes') ORDER BY table_name",
  );
  const names = contents.map((row) => String(row.table_name));
  const missing = (source.tables ?? []).filter((table) => !names.includes(table));
  if (missing.length > 0) {
    db.close();
    throw new Error(`${source.file} has no features or attributes table ${missing.map((t) => `"${t}"`).join(", ")}.`);
  }

  const warnings: string[] = [];
  const stores: { id: string; store: Store }[] = [];
  for (const row of contents) {
    const table = String(row.table_name);
    if (source.tables && !source.tables.includes(table)) continue;
    const id = `${source.prefix ?? ""}${table}`;
    if (!ID.test(id)) {
      warnings.push(`Table "${table}" not served: "${id}" isn't a valid collection id (letters, digits, "_", "-").`);
      continue;
    }
    try {
      stores.push({ id, store: tableStore(db, id, row, spatialite) });
    } catch (error) {
      warnings.push(`Table "${table}" not served: ${(error as Error).message}`);
    }
  }
  return { stores, warnings };
}

/** Whether `gpkg_extensions` registers GeoPackage's R-tree index for the column (a file may have no such table). */
function hasRtree(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const sql = "SELECT 1 FROM gpkg_extensions WHERE extension_name = 'gpkg_rtree_index' AND table_name = ? AND column_name = ?";
    return db.prepare(sql).all(table, column).length > 0;
  } catch {
    return false;
  }
}

function tableStore(db: DatabaseSync, id: string, contents: Row, spatialite: boolean): Store {
  const table = String(contents.table_name);
  const all = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as Row[];
  const columns = all(`PRAGMA table_info(${quote(table)})`) as { name: string; type: string; pk: number }[];
  const isView = all("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?", table).length > 0;
  const warnings: string[] = [];

  const idColumn = isView
    ? columns.find((c) => c.type.toUpperCase() === "INTEGER")
    : columns.find((c) => c.pk === 1 && c.type.toUpperCase() === "INTEGER");
  if (!idColumn) throw new Error(isView ? "the view has no INTEGER column for the id (Req 151)." : "it has no INTEGER primary key (Req 29, 119).");

  const geometryRow = all("SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name = ?", table)[0];
  const geometryColumn = geometryRow ? String(geometryRow.column_name) : undefined;
  let withGeometry = geometryColumn !== undefined;
  if (geometryRow) {
    const srs = all("SELECT organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id = ?", geometryRow.srs_id)[0];
    const org = String(srs?.organization ?? "").toUpperCase();
    const code = String(srs?.organization_coordsys_id ?? "");
    if (!((org === "EPSG" && code === "4326") || (org === "OGC" && code.toUpperCase() === "CRS84"))) {
      withGeometry = false;
      warnings.push(`Its geometry is in SRS ${String(geometryRow.srs_id)} (${org || "unknown"} ${code}), not WGS 84: features are served without geometry.`);
    }
  }

  const queryables: Record<string, Queryable> = {};
  const booleans = new Set<string>();
  for (const column of columns) {
    if (column.name === idColumn.name || column.name === geometryColumn) continue;
    const q = queryableOf(column.type);
    if (q === undefined) continue;
    if (q === "unknown") {
      queryables[column.name] = {};
      warnings.push(`Column "${column.name}" is declared ${column.type || "without a type"}, which isn't a GeoPackage type (Req 5).`);
      continue;
    }
    queryables[column.name] = q;
    if (q.type === "boolean") booleans.add(column.name);
  }

  const propertyNames = Object.keys(queryables);
  // Spatial filters name the geometry "geometry", as the server serves it; a table in another SRS has none to compare.
  // The R-tree, when the extension is registered for the column, finds the candidates first.
  const rtree = !isView && geometryColumn !== undefined && hasRtree(db, table, geometryColumn) ? `rtree_${table}_${geometryColumn}` : undefined;
  const geometryFilter: SqlColumn = { format: "geometry-any", column: geometryColumn!, ...(rtree ? { rtree } : {}) };
  const filterColumns: Record<string, SqlColumn> =
    withGeometry && !Object.hasOwn(queryables, "geometry") ? { ...queryables, geometry: geometryFilter } : queryables;
  const select = [idColumn.name, ...(withGeometry ? [geometryColumn!] : []), ...propertyNames].map(quote).join(", ");
  const from = quote(table);
  let decodeProblems = 0;

  const toFeature = (row: Row): Feature => {
    const properties: Record<string, unknown> = {};
    for (const name of propertyNames) {
      const value = row[name];
      properties[name] = booleans.has(name) && (value === 0 || value === 1) ? value === 1 : value;
    }
    let geometry: Geometry | null = null;
    const bytes = withGeometry ? row[geometryColumn!] : null;
    if (bytes instanceof Uint8Array) {
      try {
        const decoded = decodeGeoPackageBinary(bytes);
        if (decoded.kind === "geometry") geometry = decoded.geometry;
        else if (decoded.kind === "extended") decodeProblems++;
      } catch {
        decodeProblems++;
      }
    }
    return { type: "Feature", id: Number(row[idColumn.name]), geometry, properties };
  };

  const featureCount = Number(all(`SELECT COUNT(*) AS n FROM ${from}`)[0]!.n);
  const description = (): CollectionDescription => ({
    id,
    title: typeof contents.identifier === "string" && contents.identifier !== "" ? contents.identifier : table,
    ...(typeof contents.description === "string" && contents.description !== "" ? { description: contents.description } : {}),
    source: "geopackage",
    featureCount,
    warnings: decodeProblems > 0 ? [...warnings, `${decodeProblems} geometries couldn't be decoded (extended types or invalid values); they are served as null.`] : warnings,
  });

  return {
    describe: description,
    queryables: () => queryables,
    hasGeometry: () => withGeometry,
    conformance: () => sqlConformance({ dialect: "sqlite", spatialite }), // Spatial Functions with SpatiaLite
    async query(filter: Cql2Filter, { limit, offset }) {
      const { where, params } = toSql(filter, { dialect: "sqlite", columns: filterColumns, spatialite });
      const rows = all(`SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${quote(idColumn.name)} LIMIT ? OFFSET ?`, ...params, limit, offset);
      const numberMatched = Number(all(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`, ...params)[0]!.n);
      return { features: rows.map(toFeature), numberMatched };
    },
  };
}
