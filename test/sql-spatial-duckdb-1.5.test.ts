/** The `duckdb` dialect's S_INTERSECTS on DuckDB 1.5.4, the engine of DuckDB-WASM 1.33.1-dev57.0, as in the browser (duckdb-spatial.ts). */
import * as engine from "@duckdb/node-api-1.5";
import { duckdbSpatialSuite } from "./duckdb-spatial.ts";

duckdbSpatialSuite("DuckDB 1.5.4 (DuckDB-WASM 1.33.1-dev57.0's engine)", { version: "1.5.4", line: "core" }, engine as never);
