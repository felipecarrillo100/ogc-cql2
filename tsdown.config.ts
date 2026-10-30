import { defineConfig } from "tsdown";

export default defineConfig({
  // One entry per public entry point; keep in step with `exports` in package.json (publint checks they agree).
  entry: {
    index: "src/index.ts",
    "validate/index": "src/validate/index.ts",
    "text/index": "src/text/index.ts",
    "evaluate/index": "src/evaluate/index.ts",
    "sql/index": "src/sql/index.ts",
  },
  format: "esm",
  // Browsers and Node alike.
  platform: "neutral",
  // `.js` / `.d.ts`, as `"type": "module"` implies.
  fixedExtension: false,
  // One output file per source module, so a bundler drops what an application doesn't import.
  unbundle: true,
  dts: true,
  clean: true,
  publint: true,
  attw: { profile: "esm-only" },
});
