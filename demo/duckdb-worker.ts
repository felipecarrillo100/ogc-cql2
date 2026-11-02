/**
 * The playground's DuckDB-WASM worker: demo-server's GeoParquet files, filtered in this browser with the SQL that
 * demo-server's GeoParquet store runs (`demo-server/src/stores/duckdb-columns.ts`). DuckDB-WASM's synchronous
 * ("blocking") build, which registers JavaScript functions, in a Web Worker, as the README shows.
 *
 * Messages: `{ seq, kind: "open", id, url }` reads a file's columns and `geo` metadata; `{ seq, kind: "query", id,
 * filter, limit }` answers one page. Each answer is `{ seq, ok: true, result }` or `{ seq, ok: false, error }`.
 */
import eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import mvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import * as arrow from "apache-arrow";
import * as duckdb from "duckdb-wasm-blocking";
import type { Cql2Filter, Queryable } from "ogc-cql2";
import { duckdbFunctions } from "ogc-cql2/sql";
import { describeSql, duckdbConformance, geoSql, parquetTable, type ParquetTable } from "../demo-server/src/stores/duckdb-columns.ts";
import type { Feature } from "../demo-server/src/stores/types.ts";

export type WorkerRequest =
  | { readonly seq: number; readonly kind: "open"; readonly id: string; readonly url: string }
  | { readonly seq: number; readonly kind: "query"; readonly id: string; readonly filter: Cql2Filter; readonly limit: number };

export interface Opened {
  /** The file's queryables, with the features' geometry when spatial filters can run, as demo-server lists them. */
  readonly queryables: Readonly<Record<string, Queryable>>;
  readonly featureCount: number;
  readonly warnings: readonly string[];
  /** The classes it serves: the `duckdb` dialect's, without the spatial ones if the spatial extension didn't load. */
  readonly conformance: readonly string[];
  /** DuckDB's version, and how long opening took (the engine and the spatial extension the first time), in ms. */
  readonly engine: string;
  readonly milliseconds: number;
}

export interface Answered {
  readonly features: readonly Feature[];
  readonly numberMatched: number;
  readonly milliseconds: number;
}

export type WorkerResponse = { readonly seq: number; readonly ok: true; readonly result: Opened | Answered } | { readonly seq: number; readonly ok: false; readonly error: string };

/** The worker's side of postMessage (this file is checked with the DOM's types, where `self` is a Window). */
const post = (message: WorkerResponse): void => (self as unknown as { postMessage(m: WorkerResponse): void }).postMessage(message);

// No top-level await: Vite's default browser targets refuse it.
async function start() {
  const bundles = { mvp: { mainModule: mvp, mainWorker: "" }, eh: { mainModule: eh, mainWorker: "" } };
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.BROWSER_RUNTIME);
  await db.instantiate(() => {}); // no progress shown
  db.open({});
  const connection = db.connect();
  for (const [name, f] of Object.entries(duckdbFunctions)) {
    connection.createScalarFunction(name, new arrow.Int32(), (...args: (string | null)[]) => f.call(...args));
  }
  // GeoParquet's geometry read as WKB (BLOB), which the dialect takes as well: DuckDB-WASM 1.33 (DuckDB 1.5) fails on
  // the type GEOMETRY('OGC:CRS84') once spatial is loaded ("stoi: no conversion", duckdb/duckdb-wasm#2199).
  connection.query("SET enable_geoparquet_conversion = false");
  const warnings: string[] = [];
  let spatial = false;
  try {
    connection.query("INSTALL spatial");
    connection.query("LOAD spatial");
    spatial = true;
  } catch (error) {
    warnings.push(`DuckDB's spatial extension didn't load (${(error as Error).message.split("\n")[0]}): spatial filters are refused.`);
  }
  const engine = String(connection.query("SELECT version() AS v").toArray()[0]!.toJSON().v);
  const rows = (sql: string, params: readonly unknown[] = []): Record<string, unknown>[] => {
    const statement = connection.prepare(sql);
    try {
      return statement.query(...params).toArray().map((row: { toJSON(): Record<string, unknown> }) => row.toJSON());
    } finally {
      statement.close();
    }
  };
  return { db, rows, spatial, warnings, engine };
}

let started: ReturnType<typeof start> | undefined;
const tables = new Map<string, ParquetTable>();

async function handle(request: WorkerRequest): Promise<Opened | Answered> {
  const t0 = performance.now();
  const { db, rows, spatial, warnings, engine } = await (started ??= start());
  const file = `${request.id}.parquet`;
  if (request.kind === "open") {
    // Read by HTTP range requests: only the footer, then the row groups a query needs.
    db.registerFileURL(file, new URL(request.url, location.href).href, duckdb.DuckDBDataProtocol.HTTP, false);
    const types: Record<string, string> = {};
    for (const row of rows(describeSql(file))) types[row.column_name as string] = row.column_type as string;
    const geo = rows(geoSql(file))[0]?.geo as string | undefined;
    const table = parquetTable(file, types, geo, { spatial });
    const [ids] = rows(table.idCheckSql);
    const featureCount = Number(ids!.n);
    if (Number(ids!.ids) !== featureCount || Number(ids!.distinct_ids) !== featureCount) throw new Error(`${file}: its id column has NULLs or duplicates.`);
    tables.set(request.id, table);
    const queryables = table.filterable && !Object.hasOwn(table.queryables, "geometry") ? { ...table.queryables, geometry: { format: "geometry-any" } } : table.queryables;
    return {
      queryables, featureCount, warnings: [...warnings, ...table.warnings], conformance: duckdbConformance(spatial), engine,
      milliseconds: performance.now() - t0,
    };
  }
  const table = tables.get(request.id);
  if (!table) throw new Error(`${file} isn't open.`);
  const { page, count, params } = table.query(request.filter, request.limit, 0);
  const features = rows(page, params).map(table.toFeature);
  const numberMatched = Number(rows(count, params)[0]!.n);
  return { features, numberMatched, milliseconds: performance.now() - t0 };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { seq } = event.data;
  handle(event.data).then(
    (result) => post({ seq, ok: true, result }),
    (error: unknown) => post({ seq, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
};
