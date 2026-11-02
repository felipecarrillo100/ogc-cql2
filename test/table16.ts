/**
 * The standard's tests on its test data (OGC 21-065r2): Conformance Test 49 for Property-Property Comparisons (Annex
 * A.12, Table 16) and Conformance Test 53 for Arithmetic Expressions (Annex A.14, Table 17), their predicates and
 * expected counts, and the data. Run by `evaluate`, SQLite and both DuckDB engines.
 */
import { readFileSync } from "node:fs";

// OGC's populated places, the columns Table 16 uses (test/fixtures/ogc/README.md).
export const places = JSON.parse(readFileSync(new URL("./fixtures/ogc/data/ne_110m_populated_places_simple.geojson", import.meta.url), "utf8"))
  .features as { id: number; properties: Record<string, unknown> }[];
/** The places' queryables, as a server would list them; also the SQL tables' columns. */
export const PLACES_QUERYABLES = {
  name: { type: "string" }, nameascii: { type: "string" },
  pop_min: { type: "integer" }, pop_max: { type: "integer" }, pop_other: { type: "integer" },
  start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" },
} as const;

/** Table 16 of the standard, the rows outside the spatial and temporal classes, with their expected counts. */
export const TABLE_16: [string, number][] = [
  ["'København'=name", 1], ["'København'<=name", 137], ["'København'<name", 136], ["'København'>=name", 107],
  ["'København'>name", 106], ["'København'<>name", 242],
  ["name=nameascii", 230], ["name>=nameascii", 243], ["name>nameascii", 13], ["name<=nameascii", 230],
  ["name<nameascii", 0], ["name<>nameascii", 13],
  ["1038288=pop_other", 1], ["1038288<=pop_other", 123], ["1038288<pop_other", 122], ["1038288>=pop_other", 121],
  ["1038288>pop_other", 120], ["1038288<>pop_other", 242],
  ["pop_min=pop_max", 27], ["pop_min<=pop_max", 243], ["pop_min<pop_max", 216], ["pop_min>=pop_max", 27],
  ["pop_min>pop_max", 0], ["pop_min<>pop_max", 216],
  ['start="end"', 0], ['start<="end"', 3], ['start<"end"', 3], ['start>="end"', 0], ['start>"end"', 0], ['start<>"end"', 3],
  ["'København' LIKE 'K_benhavn'", 243], ["'København' NOT LIKE 'K_benhavn'", 0],
  ["pop_other between pop_min and pop_max", 94], ["pop_other not between pop_min and pop_max", 149],
];

/** A SQL literal of a place's value: text quoted, numbers as they are, NULL. */
export const sqlLiteral = (value: unknown): string =>
  value === null || value === undefined ? "NULL" : typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);

/** Table 17 of the standard, as it writes the predicates in CQL2-text, with their expected counts. */
export const TABLE_17: [string, number][] = [
  ["pop_other=1038280+8", 1],
  ["pop_other>=1038290-2*2^0", 123],
  ["pop_other>1038290-20/10", 122],
  ["pop_other>1038290-21 div 10", 122],
  ["pop_other>1038290-5%2", 122],
  ["pop_other<=1038200+8*11", 121],
  ["pop_other<1038280+2^3", 120],
  ["pop_other<>1038290-2^1", 242],
  ["pop_other between 4000000/4 and (3*(900000+100000))", 75],
  ["pop_other not between 4000000/4 and (3*(900000+100000))", 168],
  ["pop_other in (1000000+38288,1000000+600000+11692,3*1000000+13258,3*1000000+13257,30*100000+13259)", 3],
  ["pop_other not in (1000000+38288,1000000+600000+11692,3*1000000+13258,3*1000000+13257,30*100000+13259)", 240],
  ["1038280+8=pop_other", 1],
];
