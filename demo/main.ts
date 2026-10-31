import { CONFORMANCE, CQL2_VERSION, OTHER_CONFORMANCE, type Queryable } from "ogc-cql2";
import { toEvaluator, type Truth } from "ogc-cql2/evaluate";
import { textProblem, toText } from "ogc-cql2/text";
import { requiredConformance, validate, type Problem } from "ogc-cql2/validate";
import { ANY_COLLECTION, COLUMNS, EXAMPLES, FEATURES, SERVER_EXAMPLES, type Example } from "./samples.ts";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** An element with text content only: nothing typed by the user, or sent by the server, is parsed as HTML. */
function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

const CLASS_NAMES: Record<string, string> = {
  [CONFORMANCE.basic]: "Basic CQL2",
  [CONFORMANCE.advancedComparison]: "Advanced Comparison Operators",
  [CONFORMANCE.caseInsensitive]: "Case-insensitive Comparison",
  [OTHER_CONFORMANCE.accentInsensitive]: "Accent-insensitive Comparison",
  [OTHER_CONFORMANCE.basicSpatial]: "Basic Spatial Functions",
  [OTHER_CONFORMANCE.spatial]: "Spatial Functions",
  [OTHER_CONFORMANCE.temporal]: "Temporal Functions",
  [OTHER_CONFORMANCE.arrays]: "Array Functions",
  [OTHER_CONFORMANCE.propertyProperty]: "Property-Property Comparisons",
  [OTHER_CONFORMANCE.functions]: "Custom Functions",
  [OTHER_CONFORMANCE.arithmetic]: "Arithmetic Expressions",
};
const nameOf = (uri: string): string => CLASS_NAMES[uri] ?? uri.split("/").pop() ?? uri;

const sourceSelect = byId<HTMLSelectElement>("source");
const exampleSelect = byId<HTMLSelectElement>("example");
const filterInput = byId<HTMLTextAreaElement>("filter");
const conformanceBox = byId("conformance");
const validationOut = byId("validation");
const textOut = byId<HTMLOutputElement>("text");
const resultsTitle = byId("results-title");
const summaryOut = byId("summary");
const table = byId<HTMLTableElement>("features");

byId("version").textContent = CQL2_VERSION;

// --- Data sources: the sample features in this page, or a demo-server collection -----------------------------------

interface ServerCollection {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly featureCount: number;
  readonly warnings: readonly string[];
}

/** `undefined`: the sample features in this browser. */
let collection: (ServerCollection & { columns: readonly string[]; queryables: Record<string, Queryable> }) | undefined;
let examples: readonly Example[] = EXAMPLES;
let serverCollections: ServerCollection[] = [];

const local = el("option", "Sample features (in this browser)") as HTMLOptionElement;
local.value = "";
sourceSelect.append(local);

async function loadServerCollections(): Promise<void> {
  try {
    const res = await fetch("api/collections");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    serverCollections = ((await res.json()) as { collections: ServerCollection[] }).collections;
    for (const c of serverCollections) {
      const option = el("option", `${c.title}: demo-server, ${c.source}, ${c.featureCount} features`) as HTMLOptionElement;
      option.value = c.id;
      sourceSelect.append(option);
    }
  } catch {
    const option = el("option", "demo-server not reachable: run npm start in demo-server") as HTMLOptionElement;
    option.disabled = true;
    sourceSelect.append(option);
  }
}

/** What filters a server collection, by its source. */
const engineOf = (source: string): string =>
  source === "geopackage" ? "ogc-cql2/sql, in SQLite" : source === "postgres" ? "ogc-cql2/sql, in PostgreSQL" : "ogc-cql2/evaluate";

async function selectSource(id: string): Promise<void> {
  const found = serverCollections.find((c) => c.id === id);
  if (!found) {
    collection = undefined;
    examples = EXAMPLES;
  } else {
    const schema = (await (await fetch(`api/collections/${encodeURIComponent(id)}/queryables`)).json()) as {
      properties: Record<string, Queryable>;
    };
    collection = { ...found, columns: Object.keys(schema.properties), queryables: schema.properties };
    examples = SERVER_EXAMPLES[id] ?? ANY_COLLECTION;
    renderTable("id", collection.columns, []);
  }
  resultsTitle.replaceChildren(
    collection ? `${collection.title} ` : "Sample features ",
    el("code", collection ? `demo-server (${engineOf(collection.source)} on the server)` : "ogc-cql2/evaluate"),
  );
  fillExamples();
  showExample(0);
}

function fillExamples(): void {
  exampleSelect.replaceChildren();
  examples.forEach((example, i) => {
    const option = el("option", example.label) as HTMLOptionElement;
    option.value = String(i);
    exampleSelect.append(option);
  });
  const edited = el("option", "(edited)") as HTMLOptionElement;
  edited.value = "";
  edited.hidden = true;
  exampleSelect.append(edited);
}

// --- Conformance classes the server declares (for the validation shown here) -------------------------------------

const declared = new Set<string>(Object.values(CONFORMANCE));
for (const uri of Object.values(CONFORMANCE)) {
  const label = el("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = true;
  box.addEventListener("change", () => {
    if (box.checked) declared.add(uri);
    else declared.delete(uri);
    run();
  });
  label.append(box, ` ${nameOf(uri)}`);
  conformanceBox.append(label);
}

// --- Rendering -----------------------------------------------------------------------------------------------------

const truthLabel = (t: Truth): string => (t === null ? "NULL" : t ? "TRUE" : "FALSE");

function cell(value: unknown): HTMLElement {
  if (value === undefined) return el("td", "missing", "absent");
  if (value === null) return el("td", "null", "absent");
  return el("td", typeof value === "string" ? value : JSON.stringify(value));
}

/** A table: a first column (the result, or the feature id), then the feature's properties. */
function renderTable(first: string, columns: readonly string[], rows: readonly { lead: HTMLElement; selected: boolean; properties: Readonly<Record<string, unknown>> }[]): void {
  const head = el("tr");
  head.append(el("th", first), ...columns.map((c) => el("th", c)));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr", undefined, row.selected ? "selected" : undefined);
    tr.append(row.lead, ...columns.map((c) => cell(row.properties[c])));
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);
}

function renderLocal(results: readonly Truth[] | undefined): void {
  renderTable(
    "result",
    COLUMNS,
    FEATURES.map((feature, i) => {
      const result = results ? (results[i] ?? null) : undefined;
      return {
        lead: result === undefined ? el("td", "—") : el("td", truthLabel(result), `truth truth-${truthLabel(result).toLowerCase()}`),
        selected: result === true,
        properties: feature.properties,
      };
    }),
  );
}

function problemList(problems: readonly Problem[]): HTMLElement {
  const list = el("ul", undefined, "problems");
  for (const problem of problems) {
    const item = el("li");
    item.append(el("code", problem.code), " at ", el("code", problem.path === "" ? "(the filter)" : problem.path), " ");
    item.append(el("span", problem.message));
    if (problem.conformance) item.append(el("span", ` Class: ${nameOf(problem.conformance)}.`, "muted"));
    list.append(item);
  }
  return list;
}

// --- Running a filter ----------------------------------------------------------------------------------------------

let request = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Sends the filter to demo-server and shows its answer; a later run supersedes an earlier one. */
async function runOnServer(value: unknown, id: string, columns: readonly string[]): Promise<void> {
  const mine = ++request;
  let res: Response;
  try {
    res = await fetch(`api/collections/${encodeURIComponent(id)}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: value, limit: 100 }),
    });
  } catch {
    if (mine === request) summaryOut.textContent = "demo-server didn't answer: is it running?";
    return;
  }
  const answer = (await res.json()) as {
    numberMatched?: number;
    numberReturned?: number;
    features?: { id: unknown; properties: Record<string, unknown> }[];
    title?: string;
    detail?: string;
    problems?: Problem[];
  };
  if (mine !== request) return;
  if (!res.ok) {
    const refusal = el("div", undefined, "server-refusal");
    refusal.append(el("p", `The server refused it (HTTP ${res.status}): ${answer.title ?? ""}. ${answer.detail ?? ""}`, "problem"));
    if (answer.problems) refusal.append(problemList(answer.problems));
    validationOut.append(refusal);
    summaryOut.textContent = "";
    renderTable("id", columns, []);
    return;
  }
  const features = answer.features ?? [];
  summaryOut.textContent =
    `${answer.numberMatched} matched on the server` +
    (answer.numberMatched === features.length ? "." : `, showing the first ${features.length}.`) +
    " NULL and FALSE alike are not returned.";
  renderTable(
    "id",
    columns,
    features.map((f) => ({ lead: el("td", String(f.id)), selected: true, properties: f.properties })),
  );
}

function run(): void {
  validationOut.replaceChildren();
  textOut.textContent = "";
  textOut.className = "";
  clearTimeout(timer);

  let value: unknown;
  try {
    value = JSON.parse(filterInput.value);
  } catch (error) {
    validationOut.append(el("p", `Not JSON: ${(error as Error).message}`, "problem"));
    textOut.textContent = "—";
    summaryOut.textContent = "";
    if (collection) renderTable("id", collection.columns, []);
    else renderLocal(undefined);
    return;
  }

  // With a server collection, also against its queryables: a literal of another type than the property's is shown
  // as a type-mismatch, as the server will answer.
  const result = validate(value, { conformance: [...declared], ...(collection ? { queryables: collection.queryables } : {}) });
  validationOut.append(
    result.valid
      ? el("p", `Valid. It uses: ${requiredConformance(result.filter).map(nameOf).join(", ")}.`, "ok")
      : problemList(result.problems),
  );

  // The text and the evaluation don't depend on what the server declares: they check the filter on its own.
  const alone = validate(value);
  if (alone.valid) {
    const problem = textProblem(alone.filter);
    textOut.textContent = problem ? `Can't be written as CQL2-text: ${problem.problem} at ${problem.path}.` : toText(alone.filter);
    textOut.className = problem ? "problem" : "";
  } else {
    textOut.textContent = "—";
  }

  if (collection) {
    // Sent even when it's invalid here: the server validates on its own, and its refusal is part of the demo.
    const { id, columns } = collection;
    request++; // whatever is still on its way is now out of date
    summaryOut.textContent = "Asking demo-server…";
    timer = setTimeout(() => void runOnServer(value, id, columns), 250);
    return;
  }
  if (!alone.valid) {
    summaryOut.textContent = "Fix the filter to see which features it selects.";
    renderLocal(undefined);
    return;
  }
  const results = FEATURES.map(toEvaluator(alone.filter));
  const count = (t: Truth) => results.filter((r) => r === t).length;
  summaryOut.textContent =
    `${count(true)} selected (TRUE) · ${count(false)} FALSE · ${count(null)} NULL: unknown, so neither the filter ` +
    "nor its NOT selects them.";
  renderLocal(results);
}

function showExample(index: number): void {
  exampleSelect.value = String(index);
  filterInput.value = JSON.stringify(examples[index]!.filter, null, 2);
  run();
}

sourceSelect.addEventListener("change", () => void selectSource(sourceSelect.value));
exampleSelect.addEventListener("change", () => showExample(Number(exampleSelect.value)));
filterInput.addEventListener("input", () => {
  exampleSelect.value = "";
  run();
});

fillExamples();
showExample(0);
void loadServerCollections();
