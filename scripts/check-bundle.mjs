// Fails unless browser bundles of pages that import one entry point hold that part and nothing else: a page importing
// only `ogc-cql2/evaluate` has no CQL2-text code (written or read), no SQL code, nothing Node-specific; a page importing
// only `ogc-cql2/text` has no CQL2-text reading (`ogc-cql2/parse`). It proves the entry points split as promised.
//
// Usage: node scripts/check-bundle.mjs (after the build; it bundles dist/, as an application would)
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";

const dist = resolve("dist");

// Each marker is a string only that part's code contains.
const PARSER = "a CQL2-text token";
const PAGES = [
  {
    entry: "ogc-cql2/evaluate",
    main: 'import { toPredicate } from "ogc-cql2/evaluate";\n' +
      'console.log(toPredicate({ op: "=", args: [{ property: "a" }, 1] })({ properties: { a: 1 } }));\n',
    mustHave: { "evaluate's case-folding table": "41,1a,1,20" },
    mustNotHave: {
      "CQL2-text code (its keyword list)": "MULTILINESTRING",
      "CQL2-text code (TIMESTAMP literals)": "TIMESTAMP(",
      "CQL2-text reading (ogc-cql2/parse)": PARSER,
      "SQL code (its registered functions)": "cql2_instant",
      "a node: import": "node:",
      "require()": "require(",
    },
  },
  {
    entry: "ogc-cql2/text",
    main: 'import { toText } from "ogc-cql2/text";\nconsole.log(toText({ op: "=", args: [{ property: "a" }, 1] }));\n',
    mustHave: { "CQL2-text code (TIMESTAMP literals)": "TIMESTAMP(" },
    mustNotHave: {
      "CQL2-text reading (ogc-cql2/parse)": PARSER,
      "evaluate's case-folding table": "41,1a,1,20",
      "SQL code (its registered functions)": "cql2_instant",
      "a node: import": "node:",
    },
  },
];

async function bundle(main) {
  const page = mkdtempSync(join(tmpdir(), "ogc-cql2-bundle-"));
  try {
    writeFileSync(join(page, "index.html"), '<!doctype html><script type="module" src="./main.js"></script>');
    writeFileSync(join(page, "main.js"), main);
    await build({
      root: page,
      logLevel: "silent",
      configFile: false,
      resolve: { alias: [{ find: /^ogc-cql2\/(.+)$/, replacement: `${dist}/$1/index.js` }] },
      build: { outDir: join(page, "out"), emptyOutDir: true, minify: true },
    });
    const assets = join(page, "out", "assets");
    return readdirSync(assets)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
  } finally {
    rmSync(page, { recursive: true, force: true });
  }
}

let failed = false;
for (const { entry, main, mustHave, mustNotHave } of PAGES) {
  const code = await bundle(main);
  const problems = [
    ...Object.entries(mustHave).filter(([, m]) => !code.includes(m)).map(([what]) => `missing ${what}`),
    ...Object.entries(mustNotHave).filter(([, m]) => code.includes(m)).map(([what]) => `contains ${what}`),
  ];
  if (problems.length > 0) {
    console.error(`check:bundle failed for a page importing only ${entry}:\n  ${problems.join("\n  ")}`);
    failed = true;
  } else console.log(`check:bundle: a page importing only ${entry} bundles that part alone (${code.length} bytes)`);
}
if (failed) process.exit(1);
