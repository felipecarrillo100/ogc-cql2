/**
 * The `duckdb` dialect's S_INTERSECTS on another DuckDB engine, for `npm run check:duckdb` (scripts/check-duckdb.mjs),
 * which installs the engine in a temporary folder and sets CQL2_DUCKDB_ENGINE (the package's path),
 * CQL2_DUCKDB_VERSION (its `SELECT version()`, without the `v`) and CQL2_DUCKDB_LINE (`1.4` or `core`). Skipped
 * otherwise, so `npm test` runs only the pinned engines.
 */
import { it } from "vitest";
import { duckdbSpatialSuite, type Engine, type EngineProfile } from "./duckdb-spatial.ts";

const path = process.env.CQL2_DUCKDB_ENGINE;
if (path) {
  const version = process.env.CQL2_DUCKDB_VERSION!;
  const line = process.env.CQL2_DUCKDB_LINE as EngineProfile["line"];
  duckdbSpatialSuite(`DuckDB ${version} (check)`, { version, line }, (await import(path)) as Engine);
} else {
  it.skip("another DuckDB engine: run by `npm run check:duckdb`", () => {});
}
