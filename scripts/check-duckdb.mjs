// Runs the `duckdb` dialect's spatial suite (test/duckdb-spatial.ts) on the newest DuckDB engines, and reports what
// changed against the pinned ones and what to update. The engines: the newest `@duckdb/node-api`, and the engine
// inside the newest DuckDB-WASM (`latest` and `next`), each through the `@duckdb/node-api` of the same engine. All
// installed in a temporary folder, removed at the end: package.json and the lock file are never touched. Exits with
// 1 when a tested engine fails a test; the timing canary enforces its threshold here (CQL2_CANARY_TIMING=1), unless
// CQL2_CANARY_TIMING=0 is set: the threshold is the Mac's, and Linux runners measure a smaller gap.
//
// Usage: npm run check:duckdb (needs the network; run it before a release, or monthly)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a failed test means, and what to update: matched on the test's name. */
const ACTIONS = [
  [/selects exactly what evaluate selects/, "DuckDB's answers changed: investigate before moving a pin"],
  [/is DuckDB/, "the engine isn't the one expected: check the installed package"],
  [/R-tree index is used/, "the R-tree is no longer used for one of the literal forms: check duckdbIntersects"],
  [/ST_GeomFromWKB/, "bad WKB no longer fails the query: TRY(…) may go (duckdbIntersects)"],
  [/covering on a table with an R-tree index/, "the covering now works on an indexed table: lift the limitation (SqlColumn.covering, README, docs/architecture.md)"],
  [/covering by itself/, "DuckDB now uses the covering by itself: the comparisons may become unnecessary (SqlColumn.covering, docs)"],
  [/ST_Intersects alone without an index/, "the gap closed: no engine option needed (docs/architecture.md)"],
];

const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const npmView = (spec, field) => {
  const value = JSON.parse(npm(["view", spec, field, "--json"]));
  // Some npm versions wrap the answer in an array of one.
  return Array.isArray(value) && value.length === 1 && typeof value[0] === "object" ? value[0] : value;
};
const engineOf = (packageVersion) => packageVersion.split("-r.")[0]; // @duckdb/node-api 2.0.0-r.1 is engine 2.0.0
const pinned = (name) => engineOf(JSON.parse(readFileSync(join("node_modules", name, "package.json"), "utf8")).version);
/** The suite's line for an engine: GEOMETRY in DuckDB's core from 1.5. */
const lineOf = (engine) => {
  const [major, minor] = engine.split(".").map(Number);
  return major > 1 || minor >= 5 ? "core" : "1.4";
};

const root = mkdtempSync(join(tmpdir(), "ogc-cql2-check-duckdb-"));
let n = 0;
/** A folder of its own for each package: one `npm install` in a folder removes what an earlier one added. */
function install(spec) {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), '{ "private": true }');
  npm(["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `pkg@npm:${spec}`], dir);
  return join(dir, "node_modules", "pkg");
}

/** The engine inside a DuckDB-WASM package, read through its own Node build. */
function wasmEngine(pkg) {
  const script = `
    const path = require("path"), fs = require("fs");
    const dist = path.join(${JSON.stringify(pkg)}, "dist");
    const duckdb = require(path.join(dist, "duckdb-node-blocking.cjs"));
    const bundle = (f) => ({ mainModule: path.join(dist, f), mainWorker: "" });
    const bundles = fs.existsSync(path.join(dist, "duckdb-base.wasm"))
      ? { base: bundle("duckdb-base.wasm") } // since 1.33.1-dev110: base and threads
      : { mvp: bundle("duckdb-mvp.wasm"), eh: bundle("duckdb-eh.wasm") };
    duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME).then(async (db) => {
      await db.instantiate();
      db.open({});
      process.stdout.write(db.connect().query("SELECT version() AS v").toArray()[0].toJSON().v);
    });`;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^v/, "");
}

/** The suite on one engine: each test's name, status and, when it failed, what to update. */
function runSuite(engine, pkg) {
  const out = join(root, `results-${engine}.json`);
  spawnSync("npx", ["vitest", "run", "test/sql-spatial-duckdb-check.test.ts", "--reporter=json", `--outputFile=${out}`], {
    stdio: "ignore",
    env: { ...process.env, CQL2_DUCKDB_ENGINE: join(pkg, "lib", "index.js"), CQL2_DUCKDB_VERSION: engine, CQL2_DUCKDB_LINE: lineOf(engine), CQL2_CANARY_TIMING: process.env.CQL2_CANARY_TIMING ?? "1" },
  });
  const results = JSON.parse(readFileSync(out, "utf8")).testResults.flatMap((f) => f.assertionResults);
  return results.map((t) => ({
    title: t.title,
    status: t.status === "pending" ? "skipped" : t.status,
    action: t.status === "failed" ? (ACTIONS.find(([re]) => re.test(t.fullName))?.[1] ?? "unexpected: read the test") : undefined,
    message: t.failureMessages?.[0]?.split("\n")[0],
  }));
}

let failed = false;
try {
  const pins = { node: pinned("@duckdb/node-api"), wasm: pinned("@duckdb/node-api-1.4") };
  const nodeVersions = npmView("@duckdb/node-api", "versions");
  console.log(`Pinned (npm test runs them): DuckDB ${pins.node} (Node), DuckDB ${pins.wasm} (DuckDB-WASM's engine)\n`);

  // The engines to test, with where each comes from.
  const engines = new Map();
  const add = (engine, source) => engines.set(engine, [...(engines.get(engine) ?? []), source]);
  add(engineOf(npmView("@duckdb/node-api", "dist-tags").latest), "@duckdb/node-api latest");
  const wasmTags = npmView("@duckdb/duckdb-wasm", "dist-tags");
  const wasm = {};
  for (const tag of ["latest", "next"]) {
    if (!wasmTags[tag]) continue;
    const engine = wasmEngine(install(`@duckdb/duckdb-wasm@${wasmTags[tag]}`));
    wasm[tag] = engine;
    add(engine, `@duckdb/duckdb-wasm ${tag} (${wasmTags[tag]})`);
  }

  for (const [engine, sources] of engines) {
    console.log(`DuckDB ${engine}, from ${sources.join(", ")}`);
    if (engine === pins.node || engine === pins.wasm) {
      console.log("  pinned: already tested by npm test\n");
      continue;
    }
    const nodeApi = nodeVersions.filter((v) => v.startsWith(`${engine}-r.`)).at(-1);
    if (!nodeApi) {
      console.log(`  no @duckdb/node-api for this engine (a development build?): not tested\n`);
      continue;
    }
    console.log(`  tested through @duckdb/node-api ${nodeApi}, expectations of line "${lineOf(engine)}"`);
    for (const t of runSuite(engine, install(`@duckdb/node-api@${nodeApi}`))) {
      console.log(`  ${t.status.padEnd(7)} ${t.title}`);
      if (t.action) {
        failed = true;
        console.log(`          → ${t.action}${t.message ? `\n            (${t.message.slice(0, 160)})` : ""}`);
      }
    }
    console.log("");
  }

  if (wasm.latest && wasm.latest !== pins.wasm) {
    console.log(`DuckDB-WASM's latest ships DuckDB ${wasm.latest}, not ${pins.wasm}: when the browser moves to it, move the`);
    console.log(`@duckdb/node-api-1.4 devDependency (and its test file's profile) to that engine, after this report is clean.`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
