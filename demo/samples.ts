/** The playground's sample features and example filters. */

export interface SampleFeature {
  readonly type: "Feature";
  readonly id: number;
  readonly geometry: null;
  readonly properties: Readonly<Record<string, unknown>>;
}

const feature = (id: number, properties: Record<string, unknown>): SampleFeature => ({
  type: "Feature",
  id,
  geometry: null,
  properties,
});

/** Chosen to exercise the rules: Unicode names, a null, a missing property, a number stored as text. */
export const FEATURES: readonly SampleFeature[] = [
  feature(1, { name: "Toronto", country: "CA", population: 2794356, capital: false, founded: "1793-08-27", updated: "2026-01-15T10:00:00Z" }),
  feature(2, { name: "Ottawa", country: "CA", population: 1017449, capital: true, founded: "1826-09-26", updated: "2025-11-02T08:30:00Z" }),
  feature(3, { name: "Frankfurt am Main", country: "DE", population: 773068, capital: false, founded: "0794-02-22", updated: "2026-03-01T00:00:00Z" }),
  feature(4, { name: "München", country: "DE", population: 1512491, capital: false, founded: "1158-06-14", updated: "2024-07-19T16:45:00+02:00" }),
  feature(5, { name: "Αθήνα", country: "GR", population: 643452, capital: true, founded: null, updated: "2025-05-05T12:00:00Z" }),
  feature(6, { name: "São Paulo", country: "BR", population: 11451245, capital: false, founded: "1554-01-25", updated: "2026-02-20T09:00:00Z" }),
  feature(7, { name: "Reykjavík", country: "IS", population: 139875, capital: true, founded: "1786-08-18", updated: "2023-09-30T23:59:59Z" }),
  feature(8, { name: "STRASSBURG", country: "FR", population: 290576, capital: false, founded: "0012-01-01" }),
  feature(9, { name: "Unnamed hamlet", country: "IS", population: null, capital: false }),
  feature(10, { name: "Survey point 17", population: "40", capital: false }),
];

/** The properties shown as columns, in order. */
export const COLUMNS: readonly string[] = ["name", "country", "population", "capital", "founded", "updated"];

const p = (property: string) => ({ property });
const casei = (arg: unknown) => ({ op: "casei", args: [arg] });

export const EXAMPLES: readonly { readonly label: string; readonly filter: unknown }[] = [
  { label: "Population over 1 million", filter: { op: ">", args: [p("population"), 1000000] } },
  { label: "Name starts with “s”, any case (LIKE + CASEI)", filter: { op: "like", args: [casei(p("name")), casei("s%")] } },
  { label: "Name equals “straßburg”, any case (full case folding)", filter: { op: "=", args: [casei(p("name")), casei("straßburg")] } },
  { label: "Name equals “ΑΘΉΝΑ”, any case (Greek)", filter: { op: "=", args: [casei(p("name")), casei("ΑΘΉΝΑ")] } },
  { label: "Country is one of CA, DE", filter: { op: "in", args: [p("country"), ["CA", "DE"]] } },
  { label: "Country is not one of CA, DE (NULL when missing)", filter: { op: "not", args: [{ op: "in", args: [p("country"), ["CA", "DE"]] }] } },
  { label: "Founded before 1800 (dates)", filter: { op: "<", args: [p("founded"), { date: "1800-01-01" }] } },
  { label: "Updated in 2026 (timestamps)", filter: { op: ">=", args: [p("updated"), { timestamp: "2026-01-01T00:00:00Z" }] } },
  { label: "Capital, population between 100 000 and 1 100 000", filter: { op: "and", args: [{ op: "=", args: [p("capital"), true] }, { op: "between", args: [p("population"), 100000, 1100000] }] } },
  { label: "Population is missing (IS NULL)", filter: { op: "isNull", args: [p("population")] } },
  { label: "Population is one of the list, or missing", filter: { op: "or", args: [{ op: "in", args: [p("population"), [139875, 290576]] }, { op: "isNull", args: [p("population")] }] } },
  { label: "Name of exactly 6 characters (_ wildcards)", filter: { op: "like", args: [p("name"), "______"] } },
  { label: "Invalid: a null literal", filter: { op: "=", args: [p("population"), null] } },
  { label: "Invalid: not CQL2-JSON", filter: { op: "eq", property: "country", value: "CA" } },
  { label: "Outside the profile: a spatial function", filter: { op: "s_intersects", args: [p("geometry"), { bbox: [-80, 43, -79, 44] }] } },
  { label: "Not expressible as CQL2-text: a name with a space", filter: { op: "=", args: [p("my field"), 1] } },
];
