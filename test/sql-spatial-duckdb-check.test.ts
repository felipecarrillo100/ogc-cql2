/**
 * The `duckdb` dialect's S_INTERSECTS, and its Array Functions (since 1.6.0), on another DuckDB engine, for
 * `npm run check:duckdb` (scripts/check-duckdb.mjs),
 * which installs the engine in a temporary folder and sets CQL2_DUCKDB_ENGINE (the package's path),
 * CQL2_DUCKDB_VERSION (its `SELECT version()`, without the `v`) and CQL2_DUCKDB_LINE (`1.4` or `core`). Skipped
 * otherwise, so `npm test` runs only the pinned engines.
 */
import { it } from "vitest";
import { duckdbArraysSuite, type Engine as ArraysEngine } from "./duckdb-arrays.ts";
import { duckdbSpatialSuite, type Engine, type EngineProfile } from "./duckdb-spatial.ts";

const path = process.env.CQL2_DUCKDB_ENGINE;
if (path) {
  const version = process.env.CQL2_DUCKDB_VERSION!;
  const line = process.env.CQL2_DUCKDB_LINE as EngineProfile["line"];
  const engine = await import(path);
  duckdbSpatialSuite(`DuckDB ${version} (check)`, { version, line }, engine as Engine);
  duckdbArraysSuite(`DuckDB ${version} (check)`, engine as ArraysEngine);
} else {
  it.skip("another DuckDB engine: run by `npm run check:duckdb`", () => {});
}
