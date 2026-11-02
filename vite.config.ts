import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * `ogc-cql2` and `ogc-cql2/<part>` → the sources, so the demo always runs the current code.
 * Shared with vitest.config.ts.
 */
export const sourceAliases = [
  { find: /^ogc-cql2$/, replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  { find: /^ogc-cql2\/(.+)$/, replacement: fileURLToPath(new URL("./src/$1/index.ts", import.meta.url)) },
];

/**
 * DuckDB-WASM's synchronous ("blocking") build, the one that registers JavaScript functions; its package's `exports`
 * don't list it. The playground's DuckDB worker uses it (README, "SQL (DuckDB)").
 */
const duckdbBlocking = {
  find: "duckdb-wasm-blocking",
  replacement: fileURLToPath(new URL("./node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser-blocking.mjs", import.meta.url)),
};

/** `/api/…` → demo-server (`DEMO_SERVER`, default http://localhost:3100), in dev and preview: one origin, no CORS. */
const api = {
  "/api": {
    target: process.env.DEMO_SERVER ?? "http://localhost:3100",
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  root: "demo",
  base: "./",
  resolve: { alias: [...sourceAliases, duckdbBlocking] },
  worker: { format: "es" },
  build: { outDir: "../demo-dist", emptyOutDir: true },
  server: { proxy: api },
  preview: { proxy: api },
});
