// Fails if the package could pull anything into an application: a runtime dependency in package.json, or an import
// in dist/ of anything but the package's own files (`node:…`, a driver, another package).
//
// Usage: node scripts/check-imports.mjs (after the build)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const problems = [];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  const names = Object.keys(pkg[field] ?? {});
  if (names.length > 0) problems.push(`package.json ${field}: ${names.join(", ")}`);
}

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
for (const file of files("dist").filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))) {
  for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) problems.push(`${file} imports "${specifier}"`);
  }
}

if (problems.length > 0) {
  console.error(`check:imports failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("check:imports: no runtime dependencies, and dist/ imports only its own files");
