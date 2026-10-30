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

export default defineConfig({
  root: "demo",
  base: "./",
  resolve: { alias: sourceAliases },
  build: { outDir: "../demo-dist", emptyOutDir: true },
});
