// Fails unless a browser bundle of a page that imports only `ogc-cql2/evaluate` holds evaluate and nothing else:
// no CQL2-text code, no SQL code, nothing Node-specific. It proves the entry points split as promised.
//
// Usage: node scripts/check-bundle.mjs (after the build; it bundles dist/, as an application would)
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const dist = resolve("dist");
const page = mkdtempSync(join(tmpdir(), "ogc-cql2-bundle-"));
try {
  writeFileSync(join(page, "index.html"), '<!doctype html><script type="module" src="./main.js"></script>');
  writeFileSync(
    join(page, "main.js"),
    'import { toPredicate } from "ogc-cql2/evaluate";\n' +
      'console.log(toPredicate({ op: "=", args: [{ property: "a" }, 1] })({ properties: { a: 1 } }));\n',
  );
  await build({
    root: page,
    logLevel: "silent",
    configFile: false,
    resolve: { alias: [{ find: /^ogc-cql2\/(.+)$/, replacement: `${dist}/$1/index.js` }] },
    build: { outDir: join(page, "out"), emptyOutDir: true, minify: true },
  });
  const assets = join(page, "out", "assets");
  const bundle = readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(assets, f), "utf8"))
    .join("\n");

  // Each marker is a string only that part's code contains.
  const mustHave = { "evaluate's case-folding table": "41,1a,1,20" };
  const mustNotHave = {
    "CQL2-text code (its keyword list)": "MULTILINESTRING",
    "CQL2-text code (TIMESTAMP literals)": "TIMESTAMP(",
    "SQL code (LIKE … ESCAPE)": "ESCAPE",
    "a node: import": "node:",
    "require()": "require(",
  };
  const problems = [
    ...Object.entries(mustHave).filter(([, m]) => !bundle.includes(m)).map(([what]) => `missing ${what}`),
    ...Object.entries(mustNotHave).filter(([, m]) => bundle.includes(m)).map(([what]) => `contains ${what}`),
  ];
  if (problems.length > 0) {
    console.error(`check:bundle failed for a page importing only ogc-cql2/evaluate:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`check:bundle: a page importing only ogc-cql2/evaluate bundles evaluate alone (${bundle.length} bytes)`);
} finally {
  rmSync(page, { recursive: true, force: true });
}
