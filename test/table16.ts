/**
 * The standard's tests on its test data (OGC 21-065r2): Conformance Test 49 for Property-Property Comparisons (Annex
 * A.12, Table 16), Conformance Test 53 for Arithmetic Expressions (Annex A.14, Table 17) and the Temporal Functions
 * test-data test, their predicates and expected counts, and the data. Run by `evaluate`, SQLite and both DuckDB engines.
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
  date: { type: "string", format: "date" },
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

/**
 * The Temporal Functions test on the test data (Annex A, Temporal Functions, "test-data"), as the standard writes the
 * predicates in CQL2-text, with their expected counts.
 */
export const TABLE_TEMPORAL: [string, number][] = [
  ["t_after(\"date\",date('2022-04-16'))", 1], ["t_before(\"date\",date('2022-04-16'))", 1],
  ["t_disjoint(\"date\",date('2022-04-16'))", 2], ["t_equals(\"date\",date('2022-04-16'))", 1],
  ["t_intersects(\"date\",date('2022-04-16'))", 1], ["t_after(\"date\",interval('2022-01-01','2022-12-31'))", 1],
  ["t_before(\"date\",interval('2022-01-01','2022-12-31'))", 1],
  ["t_disjoint(\"date\",interval('2022-01-01','2022-12-31'))", 2],
  ["t_equals(\"date\",interval('2022-01-01','2022-12-31'))", 0],
  ["t_equals(\"date\",interval('2022-04-16','2022-04-16'))", 1],
  ["t_intersects(\"date\",interval('2022-01-01','2022-12-31'))", 1],
  ["t_after(start,timestamp('2022-04-16T10:13:19Z'))", 1], ["t_before(start,timestamp('2022-04-16T10:13:19Z'))", 1],
  ["t_disjoint(start,timestamp('2022-04-16T10:13:19Z'))", 2],
  ["t_equals(start,timestamp('2022-04-16T10:13:19Z'))", 1],
  ["t_intersects(start,timestamp('2022-04-16T10:13:19Z'))", 1],
  ["t_after(start,interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'))", 0],
  ["t_before(start,interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'))", 1],
  ["t_disjoint(start,interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'))", 1],
  ["t_equals(start,interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'))", 0],
  ["t_intersects(start,interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'))", 2],
  ["t_after(interval(start,end),interval('..','2022-04-16T10:13:19Z'))", 1],
  ["t_before(interval(start,end),interval('2023-01-01T00:00:00Z','..'))", 2],
  ["t_disjoint(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:15:09Z'))", 1],
  ["t_equals(interval(start,end),interval('2021-04-16T10:15:59Z','2022-04-16T10:16:06Z'))", 1],
  ["t_intersects(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:15:09Z'))", 2],
  ["T_CONTAINS(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'))", 1],
  ["T_DURING(interval(start,end),interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'))", 1],
  ["T_FINISHES(interval(start,end),interval('2020-04-16T10:13:19Z','2022-04-16T10:16:06Z'))", 1],
  ["T_FINISHEDBY(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:16:06Z'))", 1],
  ["T_MEETS(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'))", 0],
  ["T_METBY(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'))", 1],
  ["T_OVERLAPPEDBY(interval(start,end),interval('2020-04-16T10:13:19Z','2022-04-16T10:15:10Z'))", 2],
  ["T_OVERLAPS(interval(start,end),interval('2022-04-16T10:13:19Z','2023-04-16T10:15:10Z'))", 1],
  ["T_STARTEDBY(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'))", 1],
  ["T_STARTS(interval(start,end),interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'))", 0],
];

/** Table 16's rows of the Temporal Functions class: the same predicates with the operands swapped. */
export const TABLE_16_TEMPORAL: [string, number][] = [
  ["t_after(date('2022-04-16'),\"date\")", 1], ["t_before(date('2022-04-16'),\"date\")", 1],
  ["t_disjoint(date('2022-04-16'),\"date\")", 2], ["t_equals(date('2022-04-16'),\"date\")", 1],
  ["t_intersects(date('2022-04-16'),\"date\")", 1], ["t_after(interval('2022-01-01','2022-12-31'),\"date\")", 1],
  ["t_before(interval('2022-01-01','2022-12-31'),\"date\")", 1],
  ["t_disjoint(interval('2022-01-01','2022-12-31'),\"date\")", 2],
  ["t_equals(interval('2022-01-01','2022-12-31'),\"date\")", 0],
  ["t_equals(interval('2022-04-16','2022-04-16'),\"date\")", 1],
  ["t_intersects(interval('2022-01-01','2022-12-31'),\"date\")", 1],
  ["t_after(timestamp('2022-04-16T10:13:19Z'),start)", 1], ["t_before(timestamp('2022-04-16T10:13:19Z'),start)", 1],
  ["t_disjoint(timestamp('2022-04-16T10:13:19Z'),start)", 2],
  ["t_equals(timestamp('2022-04-16T10:13:19Z'),start)", 1],
  ["t_intersects(timestamp('2022-04-16T10:13:19Z'),start)", 1],
  ["t_after(interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'),start)", 1],
  ["t_before(interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'),start)", 0],
  ["t_disjoint(interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'),start)", 1],
  ["t_equals(interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'),start)", 0],
  ["t_intersects(interval('2022-01-01T00:00:00Z','2022-12-31T23:59:59Z'),start)", 2],
  ["t_after(interval('2023-01-01T00:00:00Z','..'),interval(start,end))", 2],
  ["t_before(interval('..','2022-04-16T10:13:19Z'),interval(start,end))", 1],
  ["t_disjoint(interval('2022-04-16T10:13:19Z','2022-04-16T10:15:09Z'),interval(start,end))", 1],
  ["t_equals(interval('2021-04-16T10:15:59Z','2022-04-16T10:16:06Z'),interval(start,end))", 1],
  ["t_intersects(interval('2022-04-16T10:13:19Z','2022-04-16T10:15:09Z'),interval(start,end))", 2],
  ["T_CONTAINS(interval('2021-04-16T10:13:19Z','2023-04-16T10:15:10Z'),interval(start,end))", 2],
  ["T_DURING(interval('2022-07-01T00:00:00Z','2022-12-31T23:59:59Z'),interval(start,end))", 1],
  ["T_FINISHES(interval('2022-04-16T10:13:19Z','2022-04-16T10:16:06Z'),interval(start,end))", 1],
  ["T_FINISHEDBY(interval('2022-04-16T10:13:19Z','2022-04-16T10:16:06Z'),interval(start,end))", 0],
  ["T_MEETS(interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'),interval(start,end))", 1],
  ["T_METBY(interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'),interval(start,end))", 0],
  ["T_OVERLAPPEDBY(interval('2020-04-16T10:13:19Z','2022-04-16T10:15:10Z'),interval(start,end))", 0],
  ["T_OVERLAPS(interval('2022-04-16T10:13:19Z','2023-04-16T10:15:10Z'),interval(start,end))", 0],
  ["T_STARTEDBY(interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'),interval(start,end))", 0],
  ["T_STARTS(interval('2022-04-16T10:13:19Z','2022-04-16T10:15:10Z'),interval(start,end))", 1],
];
