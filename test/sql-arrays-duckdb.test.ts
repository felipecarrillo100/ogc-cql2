/** Array Functions in the `duckdb` dialect on DuckDB 2.0 (duckdb-arrays.ts). */
import * as engine from "@duckdb/node-api";
import { duckdbArraysSuite } from "./duckdb-arrays.ts";

duckdbArraysSuite("DuckDB 2.0", engine as never);
