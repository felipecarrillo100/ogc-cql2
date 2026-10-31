/**
 * The standard's own examples (tag `cql2-1.0.0`, `cql2/standard/schema/examples/json`), all valid CQL2.
 *
 * The ones in the profile must validate and convert to CQL2-text, and that text must mean the same filter as the
 * standard's own text example (`examples/text/`): both are read back with another implementation, cql2-rs (the
 * `cql2-wasm` build, a development dependency), and must give the standard's JSON. Every other example must be
 * refused only as `outside-profile` or, for a custom function, `unknown-operator`: never as malformed, since none of
 * them is.
 */
import { readdirSync, readFileSync } from "node:fs";
import { initSync, parseText } from "cql2-wasm";
import { describe, expect, it } from "vitest";
import { toText } from "ogc-cql2/text";
import { validate } from "ogc-cql2/validate";
import { schemaAccepts } from "./schema.ts";

const dir = new URL("./fixtures/ogc/examples/json/", import.meta.url);
const examples = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name): [string, unknown] => [name.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(name, dir), "utf8"))]);

/** Reviewed by hand against `examples/text/`: each is the portable form, in the profile's three classes. */
const IN_PROFILE = new Set([
  "clause6_02a", "clause6_02d", "clause6_03", "clause7_01", "clause7_02", "clause7_03a", "clause7_03b", "clause7_04",
  "example01", "example02", "example03", "example04", "example05a", "example05b", "example06a", "example06b",
  "example09", "example10", "example11", "example12", "example13", "example14", "example15", "example16",
  "example17", "example18", "example19", "example26", "example28", "example29", "example30", "example31",
  "example32", "example33", "example34", "example35", "example36", "example37", "example38", "example39",
  "example40", "example41", "example42", "example43", "example44", "example71", "example86",
]);

initSync({ module: readFileSync(new URL("../node_modules/cql2-wasm/cql2_wasm_bg.wasm", import.meta.url)) });

/** A CQL2-text read with cql2-rs, in canonical form. */
function readWithCql2rs(text: string): string {
  const json: unknown = parseText(text).to_json();
  return canonical(typeof json === "string" ? JSON.parse(json) : json);
}

/**
 * A filter as JSON with sorted keys and AND / OR chains flattened: cql2-rs's key order doesn't matter, and it reads
 * `a OR b OR c` as `(a OR b) OR c`, the same filter (AND and OR are associative).
 */
function canonical(value: unknown): string {
  const flat = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(flat);
    if (!x || typeof x !== "object") return x;
    const o = x as { op?: unknown; args?: unknown[] };
    if ((o.op === "and" || o.op === "or") && Array.isArray(o.args)) {
      return { ...o, args: o.args.map(flat).flatMap((a) => ((a as { op?: unknown }).op === o.op ? (a as { args: unknown[] }).args : [a])) };
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, flat(v)]));
  };
  return JSON.stringify(flat(value), (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
}

/**
 * cql2-rs 0.5.6 reads the standard's text of example06a, `eo:cloud_cover BETWEEN 0.1 AND 0.2 AND landsat:wrs_row=28
 * AND …`, as the BETWEEN alone (it takes the next AND for BETWEEN's): a parser bug there. Our text, with each
 * comparison in parentheses, reads back complete; only the standard's text is skipped for it.
 */
const CQL2RS_MISREADS = new Set(["example06a"]);

describe("the standard's examples", () => {
  it("are all there, and the official schema accepts every one", () => {
    expect(examples).toHaveLength(109);
    expect(examples.filter(([, filter]) => !schemaAccepts(filter)).map(([name]) => name)).toEqual([]);
  });

  it.each(examples.filter(([name]) => IN_PROFILE.has(name)))("%s is in the profile", (_, filter) => {
    expect(validate(filter).valid).toBe(true);
    expect(() => toText(filter as never)).not.toThrow();
  });

  it.each(examples.filter(([name]) => IN_PROFILE.has(name)))("%s: our CQL2-text means what the standard's does", (name, filter) => {
    const expected = canonical(filter);
    expect(readWithCql2rs(toText(filter as never))).toBe(expected);
    if (!CQL2RS_MISREADS.has(name)) {
      const standardText = readFileSync(new URL(`./fixtures/ogc/examples/text/${name}.txt`, import.meta.url), "utf8");
      expect(readWithCql2rs(standardText)).toBe(expected);
    }
  });

  it.each(examples.filter(([name]) => !IN_PROFILE.has(name)))("%s is refused only as outside the profile", (_, filter) => {
    const result = validate(filter);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    for (const problem of result.problems) {
      expect(["outside-profile", "unknown-operator"]).toContain(problem.code);
      expect(problem.conformance).toMatch(/^http:\/\/www\.opengis\.net\/spec\/cql2\/1\.0\/conf\//);
    }
  });
});
