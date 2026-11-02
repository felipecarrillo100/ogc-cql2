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
import { fromText } from "ogc-cql2/parse";
import { toText } from "ogc-cql2/text";
import { validate } from "ogc-cql2/validate";
import { readText } from "../src/parse/read.ts";
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
  "clause7_05", "example27", "example70", // Accent-insensitive Comparison, since 0.5.0
  // The spatial classes, since 0.6.0: those with the property first.
  "clause7_07", "clause7_10", "example07", "example08", "example23", "example24", "example25", "example45",
  "example47", "example48", "example50", "example51", "example52",
  // Property-Property Comparisons, since 1.1.0: the geometry literal first, which Permission 6 let a server refuse.
  "clause7_16", "example46", "example49", "example83", "example84",
  // Arithmetic Expressions, since 1.2.0.
  "clause6_02c", "clause7_19", "example72", "example73", "example74", "example75", "example76", "example77", "example78",
  "example85",
  // Temporal Functions, since 1.3.0.
  "clause7_12", "clause7_13", "clause7_17", "example20", "example21", "example22", "example53", "example54", "example55",
  "example56", "example57", "example58", "example59", "example61", "example62", "example64", "example65", "example66",
  "example67",
]);

/**
 * Valid in the schema, but against the standard's own rule that an interval's two ends "have the same granularity (i.e.,
 * they are either timestamps or dates)": each writes a date at one end and a timestamp at the other. Refused as a type
 * mismatch, the error the standard lists for such an interval.
 */
const MIXED_INTERVALS = new Set(["example60", "example63"]);

/**
 * cql2-rs 0.5.6 reads a geometry's Z coordinates as dropped and BBOX(…) as a function call (measured), so for the
 * spatial examples our text is compared with cql2-rs's reading of the standard's text, not with the standard's JSON.
 */
const isSpatial = (filter: unknown) => JSON.stringify(filter).includes('"op":"s_');

initSync({ module: readFileSync(new URL("../node_modules/cql2-wasm/cql2_wasm_bg.wasm", import.meta.url)) });

/** A CQL2-text read with cql2-rs, in canonical form. */
/**
 * cql2-rs 0.5.6 reads a signed number, `-1`, as `-1 * 1` (`{"op": "*", "args": [-1, 1]}`), in the standard's texts
 * too (measured): its multiplications by −1 of a number are folded back into the number, which is what the text means.
 */
const signedNumbers = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(signedNumbers);
  if (typeof x !== "object" || x === null) return x;
  const { op, args } = x as { op?: unknown; args?: unknown[] };
  if (op === "*" && args?.length === 2 && args[0] === -1 && typeof args[1] === "number") return -args[1];
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, signedNumbers(v)]));
};

/**
 * cql2-rs 0.5.6 names the temporal functions in lower case (`t_finishedby`, measured), where CQL2-JSON writes four of
 * them in camel case (`t_finishedBy`, `t_metBy`, `t_overlappedBy`, `t_startedBy`): the same functions.
 */
const CAMEL: Readonly<Record<string, string>> = Object.fromEntries(
  ["t_finishedBy", "t_metBy", "t_overlappedBy", "t_startedBy"].map((name) => [name.toLowerCase(), name]),
);
const camelCase = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(camelCase);
  if (typeof x !== "object" || x === null) return x;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "op" && typeof v === "string" ? (CAMEL[v] ?? v) : camelCase(v)]));
};

function readWithCql2rs(text: string): string {
  const json: unknown = parseText(text).to_json();
  return canonical(camelCase(signedNumbers(typeof json === "string" ? JSON.parse(json) : json)));
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

/**
 * The standard writes these instants differently in its two encodings: `05:30:00.000000Z` in the text,
 * `05:30:00Z` in the JSON, the same instant. The reading keeps what the text says, so these are compared with a zero
 * fraction dropped.
 */
const ZERO_FRACTIONS = new Set(["example54", "example55", "example82"]);
const dropZeroFractions = (x: unknown): unknown => JSON.parse(JSON.stringify(x).replace(/(T\d\d:\d\d:\d\d)\.0+Z/g, "$1Z"));

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
    const standardText = readFileSync(new URL(`./fixtures/ogc/examples/text/${name}.txt`, import.meta.url), "utf8");
    if (isSpatial(filter)) {
      expect(readWithCql2rs(toText(filter as never))).toBe(readWithCql2rs(standardText));
      return;
    }
    const expected = canonical(filter);
    expect(readWithCql2rs(toText(filter as never))).toBe(expected);
    const standard = (text: string) => (ZERO_FRACTIONS.has(name) ? canonical(dropZeroFractions(JSON.parse(readWithCql2rs(text)))) : readWithCql2rs(text));
    if (!CQL2RS_MISREADS.has(name)) expect(standard(standardText)).toBe(expected);
  });

  it.each(examples.filter(([name]) => MIXED_INTERVALS.has(name)))("%s is refused as an interval of a date and a timestamp", (_, filter) => {
    const result = validate(filter);
    expect(result.valid ? [] : result.problems.map((p) => p.code)).toEqual(["type-mismatch"]);
  });

  it.each(examples.filter(([name]) => !IN_PROFILE.has(name) && !MIXED_INTERVALS.has(name)))("%s is refused only as outside the profile", (_, filter) => {
    const result = validate(filter);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    for (const problem of result.problems) {
      expect(["outside-profile", "unknown-operator"]).toContain(problem.code);
      expect(problem.conformance).toMatch(/^http:\/\/www\.opengis\.net\/spec\/cql2\/1\.0\/conf\//);
    }
  });
});

// --- Reading the standard's text examples (`ogc-cql2/parse`) ----------------------------------------------------------

const textDir = new URL("./fixtures/ogc/examples/text/", import.meta.url);
/** Each text example with the JSON example it encodes: `example36-alt01.txt` is another text of `example36.json`. */
const texts = readdirSync(textDir)
  .filter((name) => name.endsWith(".txt"))
  .sort()
  .map((name): [string, string, unknown] => {
    const base = name.replace(/(-alt01)?\.txt$/, "");
    return [name.replace(/\.txt$/, ""), readFileSync(new URL(name, textDir), "utf8"), examples.find(([n]) => n === base)![1]];
  });


describe("the standard's text examples, read", () => {
  it("are all there: 109, and 11 other texts of them", () => {
    expect(texts).toHaveLength(120);
    expect(texts.filter(([name]) => name.endsWith("-alt01"))).toHaveLength(11);
  });

  // This also shows that no example uses a keyword unquoted as a property name: each would be refused.
  it.for(texts)("%s reads exactly as its JSON example", ([name, text, json]) => {
    const read = readText(text);
    expect(ZERO_FRACTIONS.has(name) ? dropZeroFractions(read) : read).toEqual(json);
  });

  it.for(texts.filter(([name]) => IN_PROFILE.has(name.replace(/-alt01$/, ""))))("%s comes out of fromText, and reads back through toText", ([name, text, json]) => {
    const zero = ZERO_FRACTIONS.has(name) ? dropZeroFractions : (x: unknown) => x;
    expect(zero(fromText(text))).toEqual(json);
    // toText writes -0 (the standard's "-0.0") as 0, the same coordinate: compared as JSON, where they are one value.
    const asJson = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;
    expect(asJson(zero(readText(toText(fromText(text)))))).toEqual(asJson(json));
  });

  it.for(texts.filter(([name]) => !IN_PROFILE.has(name.replace(/-alt01$/, "")) && !MIXED_INTERVALS.has(name.replace(/-alt01$/, ""))))("%s is refused by fromText only as outside the profile", ([, text]) => {
    let error: { code?: string; details?: { problems?: { code: string; conformance?: string; message: string }[] } } = {};
    try {
      fromText(text);
    } catch (e) {
      error = e as typeof error;
    }
    expect(error.code).toBe("invalid-filter");
    for (const problem of error.details!.problems!) {
      expect(["outside-profile", "unknown-operator"]).toContain(problem.code);
      expect(problem.conformance).toMatch(/^http:\/\/www\.opengis\.net\/spec\/cql2\/1\.0\/conf\//);
    }
  });
});
