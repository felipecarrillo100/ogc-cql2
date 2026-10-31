/** The `duckdb` dialect's S_INTERSECTS on DuckDB 1.4.3, the engine of DuckDB-WASM 1.32.0, as in the browser (duckdb-spatial.ts). */
import * as engine from "@duckdb/node-api-1.4";
import { duckdbSpatialSuite } from "./duckdb-spatial.ts";

duckdbSpatialSuite("DuckDB 1.4.3 (DuckDB-WASM 1.32.0's engine)", { version: "1.4.3", line: "1.4" }, engine as never);
