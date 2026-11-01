/**
 * `fromText` reads back what `toText` writes, exactly: the DuckDB test's generated filters (for property names that
 * are keywords, hold a colon, or end in U+1680) and the spatial tests' filters. The same texts are read with another
 * implementation, cql2-rs (`cql2-wasm`, a development dependency), which must give the same filters too.
 */
import { readFileSync } from "node:fs";
import { initSync, parseText } from "cql2-wasm";
import { describe, expect, it } from "vitest";
import type { Cql2Filter } from "ogc-cql2";
import { fromText } from "ogc-cql2/parse";
import { textProblem, toText } from "ogc-cql2/text";
import { generateFilters } from "./corpus.ts";
import { FILTERS, RELATION_FILTERS } from "./spatial-cases.ts";

const corpus = generateFilters(["s", "date", "In", "eo:cloud_cover", "a\u1680"]);
const spatial = [...FILTERS, ...RELATION_FILTERS];

describe("fromText reads back what toText writes", () => {
  it.for([
    ["the generated filters", corpus],
    ["the spatial filters", spatial],
  ] as const)("%s", ([, filters]) => {
    const differences: string[] = [];
    let written = 0;
    for (const filter of filters) {
      if (textProblem(filter)) continue; // not expressible: toText refuses it (its own tests)
      written += 1;
      const text = toText(filter);
      const read = fromText(text);
      if (!Object.is(JSON.stringify(read), JSON.stringify(filter))) differences.push(`${text}\n    ${JSON.stringify(read)}`);
    }
    expect(written).toBeGreaterThan(filters.length * 0.9);
    expect(differences.slice(0, 10).join("\n")).toBe("");
  });

  it("the corpus is large, and holds what CQL2-text can't write (backslashes), which is skipped", () => {
    expect(corpus.length).toBeGreaterThan(10_000);
    expect(corpus.some((f) => textProblem(f)?.problem === "backslash")).toBe(true);
  });
});

initSync({ module: readFileSync(new URL("../node_modules/cql2-wasm/cql2_wasm_bg.wasm", import.meta.url)) });

/**
 * U+1680 (Ogham space mark) is in both the grammar's `whitespace` and its `identifierStart`. cql2-rs 0.5.6 reads it
 * after a name as a space (`a\u1680 = 1` would be `a = 1`), so `toText` writes such a name in double quotes, which
 * cql2-rs refuses instead of misreading. Those filters are left out of the comparison; `fromText` reads them back
 * exactly (above).
 */
const OGHAM_NAME = "a\u1680";

describe("cql2-rs reads toText's output as the same filters", () => {
  it("a name holding U+1680: cql2-rs refuses toText's quoted form, it doesn't read another property", () => {
    const text = toText({ op: "=", args: [{ property: OGHAM_NAME }, 1] });
    expect(text).toBe(`"${OGHAM_NAME}" = 1`);
    expect(() => parseText(text)).toThrow();
  });

  it("the generated filters (but for the name ending in U+1680)", () => {
    const differences: string[] = [];
    for (const filter of corpus) {
      if (JSON.stringify(filter).includes(OGHAM_NAME)) continue;
      if (textProblem(filter)) continue;
      const text = toText(filter);
      const json: unknown = parseText(text).to_json();
      const read = typeof json === "string" ? JSON.parse(json) : json;
      if (!sameFilter(read, filter)) differences.push(`${text}\n    cql2-rs ${JSON.stringify(read)}`);
    }
    expect(differences.slice(0, 10).join("\n")).toBe("");
  });
});

/**
 * The same filter, whatever cql2-rs's key order, with its `a OR b OR c` read as `(a OR b) OR c` flattened, and its
 * reading of a negative number, `-1` as `{"op": "*", "args": [-1, 1]}` (cql2-rs 0.5.6), taken as the number.
 */
function sameFilter(a: unknown, b: Cql2Filter): boolean {
  const flat = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(flat);
    if (!x || typeof x !== "object") return x;
    const o = x as { op?: unknown; args?: unknown[] };
    if (o.op === "*" && o.args?.length === 2 && o.args[0] === -1 && typeof o.args[1] === "number") return -o.args[1];
    if ((o.op === "and" || o.op === "or") && Array.isArray(o.args)) {
      return { op: o.op, args: o.args.map(flat).flatMap((arg) => ((arg as { op?: unknown }).op === o.op ? (arg as { args: unknown[] }).args : [arg])) };
    }
    return Object.fromEntries(Object.entries(x).sort(([k], [l]) => (k < l ? -1 : 1)).map(([k, v]) => [k, flat(v)]));
  };
  return JSON.stringify(flat(a)) === JSON.stringify(flat(b));
}
