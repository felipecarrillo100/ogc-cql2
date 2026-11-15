/** Array Functions in the `duckdb` dialect on DuckDB 1.5.4, the engine of DuckDB-WASM 1.33.1-dev57.0 (duckdb-arrays.ts). */
import * as engine from "@duckdb/node-api-1.5";
import { duckdbArraysSuite } from "./duckdb-arrays.ts";

duckdbArraysSuite("DuckDB 1.5.4", engine as never);
