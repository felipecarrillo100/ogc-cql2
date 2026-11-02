/**
 * Collections read from GeoParquet (or plain Parquet) files, in place, filtered by DuckDB with `ogc-cql2/sql`'s
 * `duckdb` dialect.
 *
 * - One file per collection, as for GeoJSON. The file is read where it lies, never loaded into a table, so there is
 *   no index: GeoParquet's bbox covering, when the file has one, skips row groups and rows before the exact test.
 * - What is served and how it's filtered is `duckdb-columns.ts`'s, shared with the playground's DuckDB-WASM worker:
 *   the queryables from the column types; the id a column (`id`, unless `idColumn` says), unique and never NULL; the
 *   geometry the `geo` metadata's primary column, read as WKB; values selected through `duckdbValue`, so what is
 *   served is exactly what the SQL compares.
 * - Spatial filters need DuckDB's spatial extension, downloaded from DuckDB's site the first time. Without it the
 *   features are served, and spatial filters are refused.
 */
import { DuckDBInstance, DuckDBScalarFunction, INTEGER, VARCHAR, type DuckDBValue } from "@duckdb/node-api";
import { CONFORMANCE, type Cql2Filter } from "ogc-cql2";
import { duckdbFunctions } from "ogc-cql2/sql";
import { describeSql, geoSql, parquetTable } from "./duckdb-columns.ts";
import { BASE_CLASSES, type CollectionDescription, type Store } from "./types.ts";

export interface GeoParquetSource {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  /** The id column; default `id`. */
  readonly idColumn?: string;
}

/** One DuckDB database for the process, in memory, with ogc-cql2's functions registered. */
export interface DuckDB {
  /** Whether the spatial extension loaded. */
  readonly spatial: boolean;
  readonly warnings: readonly string[];
  /** The rows of a query, one query at a time: a DuckDB connection runs one statement at once. */
  rows(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  close(): void;
}

/** Opens the database: `duckdbFunctions` registered, then the spatial extension, unless `spatial` is false. */
export async function openDuckDB({ spatial = true }: { spatial?: boolean } = {}): Promise<DuckDB> {
  const instance = await DuckDBInstance.create();
  const connection = await instance.connect();
  const types = { VARCHAR, INTEGER };
  for (const [name, f] of Object.entries(duckdbFunctions)) {
    connection.registerScalarFunction(
      DuckDBScalarFunction.create({
        name,
        returnType: types[f.returns],
        parameterTypes: f.parameters.map((t) => types[t]),
        mainFunction: (_info, input, output) => {
          const args = f.parameters.map((_, i) => input.getColumnVector(i));
          for (let row = 0; row < input.rowCount; row++) output.setItem(row, f.call(...args.map((a) => a.getItem(row) as string | null)));
          output.flush();
        },
      }),
    );
  }
  const warnings: string[] = [];
  let loaded = false;
  if (spatial) {
    try {
      await connection.run("INSTALL spatial");
      await connection.run("LOAD spatial");
      loaded = true;
    } catch (error) {
      warnings.push(`DuckDB's spatial extension didn't load (${(error as Error).message.split("\n")[0]}): spatial filters are refused.`);
    }
  }
  let queue: Promise<unknown> = Promise.resolve();
  return {
    spatial: loaded,
    warnings,
    rows(sql, params = []) {
      const task = async () => (await connection.runAndReadAll(sql, params as DuckDBValue[])).getRowObjects() as Record<string, unknown>[];
      const next = queue.then(task, task);
      queue = next.catch(() => undefined);
      return next;
    },
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

/** Makes the store for one file. Throws if it can't be served. */
export async function openGeoParquet(duck: DuckDB, source: GeoParquetSource): Promise<Store> {
  const types: Record<string, string> = {};
  for (const row of await duck.rows(describeSql(source.file))) types[row.column_name as string] = row.column_type as string;
  const [geo] = await duck.rows(geoSql(source.file));
  const table = parquetTable(source.file, types, geo?.geo as string | undefined, { spatial: duck.spatial, ...(source.idColumn ? { idColumn: source.idColumn } : {}) });
  const [ids] = await duck.rows(table.idCheckSql);
  const featureCount = Number(ids!.n);
  if (Number(ids!.ids) !== featureCount || Number(ids!.distinct_ids) !== featureCount) {
    throw new Error(`its id column "${source.idColumn ?? "id"}" has NULLs or duplicates.`);
  }
  const description: CollectionDescription = { id: source.id, title: source.title, source: "geoparquet", featureCount, warnings: table.warnings };

  return {
    describe: () => description,
    queryables: () => table.queryables,
    hasGeometry: () => table.filterable,
    conformance: () =>
      duck.spatial
        ? [...BASE_CLASSES, CONFORMANCE.spatial]
        : BASE_CLASSES.filter((c) => c !== CONFORMANCE.basicSpatial && c !== CONFORMANCE.basicSpatialPlus),
    async query(filter: Cql2Filter, { limit, offset }) {
      const { page, count, params } = table.query(filter, limit, offset);
      const rows = await duck.rows(page, params);
      const [n] = await duck.rows(count, params);
      return { features: rows.map(table.toFeature), numberMatched: Number(n!.n) };
    },
  };
}
