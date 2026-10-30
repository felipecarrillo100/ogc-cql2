import { defineConfig } from "vitest/config";
import { sourceAliases } from "./vite.config.ts";

export default defineConfig({
  resolve: { alias: sourceAliases },
  test: { include: ["test/**/*.test.ts"] },
});
