/**
 * The standard's own examples (tag `cql2-1.0.0`, `cql2/standard/schema/examples/json`), all valid CQL2.
 *
 * The ones in the profile must validate and convert to CQL2-text. Every other one must be refused only as
 * `outside-profile` or, for a custom
 * function, `unknown-operator`: never as malformed, since none of them is.
 */
import { readdirSync, readFileSync } from "node:fs";
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

describe("the standard's examples", () => {
  it("are all there, and the official schema accepts every one", () => {
    expect(examples).toHaveLength(109);
    expect(examples.filter(([, filter]) => !schemaAccepts(filter)).map(([name]) => name)).toEqual([]);
  });

  it.each(examples.filter(([name]) => IN_PROFILE.has(name)))("%s is in the profile", (_, filter) => {
    expect(validate(filter).valid).toBe(true);
    expect(() => toText(filter as never)).not.toThrow();
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
