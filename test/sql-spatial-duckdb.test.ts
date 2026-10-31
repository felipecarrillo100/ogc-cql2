/** The `duckdb` dialect's S_INTERSECTS on DuckDB 2.0, as in Node (duckdb-spatial.ts). */
import * as engine from "@duckdb/node-api";
import { duckdbSpatialSuite } from "./duckdb-spatial.ts";

duckdbSpatialSuite("DuckDB 2.0", { version: "2.0.0", line: "core" }, engine as never);
