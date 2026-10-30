import { CONFORMANCE, CQL2_VERSION, OTHER_CONFORMANCE } from "ogc-cql2";
import { toEvaluator, type Truth } from "ogc-cql2/evaluate";
import { textProblem, toText } from "ogc-cql2/text";
import { requiredConformance, validate } from "ogc-cql2/validate";
import { COLUMNS, EXAMPLES, FEATURES } from "./samples.ts";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** An element with text content only: nothing typed by the user is ever parsed as HTML. */
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

const exampleSelect = byId<HTMLSelectElement>("example");
const filterInput = byId<HTMLTextAreaElement>("filter");
const conformanceBox = byId("conformance");
const validationOut = byId("validation");
const textOut = byId<HTMLOutputElement>("text");
const summaryOut = byId("summary");
const table = byId<HTMLTableElement>("features");

byId("version").textContent = CQL2_VERSION;

EXAMPLES.forEach((example, i) => {
  const option = el("option", example.label) as HTMLOptionElement;
  option.value = String(i);
  exampleSelect.append(option);
});
const edited = el("option", "(edited)") as HTMLOptionElement;
edited.value = "";
edited.hidden = true;
exampleSelect.append(edited);

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

const truthLabel = (t: Truth): string => (t === null ? "NULL" : t ? "TRUE" : "FALSE");

function cell(value: unknown): HTMLElement {
  if (value === undefined) return el("td", "missing", "absent");
  if (value === null) return el("td", "null", "absent");
  return el("td", typeof value === "string" ? value : JSON.stringify(value));
}

function renderFeatures(results: readonly Truth[] | undefined): void {
  const head = el("tr");
  head.append(el("th", "result"), ...COLUMNS.map((c) => el("th", c)));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  FEATURES.forEach((feature, i) => {
    const row = el("tr");
    const result = results ? (results[i] ?? null) : undefined;
    if (result === true) row.className = "selected";
    row.append(
      result === undefined ? el("td", "—") : el("td", truthLabel(result), `truth truth-${truthLabel(result).toLowerCase()}`),
      ...COLUMNS.map((c) => cell(feature.properties[c])),
    );
    tbody.append(row);
  });
  table.replaceChildren(thead, tbody);
}

function run(): void {
  validationOut.replaceChildren();
  textOut.textContent = "";
  textOut.className = "";

  let value: unknown;
  try {
    value = JSON.parse(filterInput.value);
  } catch (error) {
    validationOut.append(el("p", `Not JSON: ${(error as Error).message}`, "problem"));
    textOut.textContent = "—";
    summaryOut.textContent = "";
    renderFeatures(undefined);
    return;
  }

  const result = validate(value, { conformance: [...declared] });
  if (result.valid) {
    validationOut.append(el("p", `Valid. It uses: ${requiredConformance(result.filter).map(nameOf).join(", ")}.`, "ok"));
  } else {
    const list = el("ul", undefined, "problems");
    for (const problem of result.problems) {
      const item = el("li");
      item.append(el("code", problem.code), " at ", el("code", problem.path === "" ? "(the filter)" : problem.path), " ");
      item.append(el("span", problem.message));
      if (problem.conformance) item.append(el("span", ` Class: ${nameOf(problem.conformance)}.`, "muted"));
      list.append(item);
    }
    validationOut.append(list);
  }

  // The text and the evaluation don't depend on what the server declares: they check the filter on its own.
  const alone = validate(value);
  if (!alone.valid) {
    textOut.textContent = "—";
    summaryOut.textContent = "Fix the filter to see which features it selects.";
    renderFeatures(undefined);
    return;
  }

  const problem = textProblem(alone.filter);
  if (problem) {
    textOut.textContent = `Can't be written as CQL2-text: ${problem.problem} at ${problem.path}.`;
    textOut.className = "problem";
  } else {
    textOut.textContent = toText(alone.filter);
  }

  const results = FEATURES.map(toEvaluator(alone.filter));
  const count = (t: Truth) => results.filter((r) => r === t).length;
  summaryOut.textContent =
    `${count(true)} selected (TRUE) · ${count(false)} FALSE · ${count(null)} NULL: unknown, so neither the filter ` +
    "nor its NOT selects them.";
  renderFeatures(results);
}

function showExample(index: number): void {
  exampleSelect.value = String(index);
  filterInput.value = JSON.stringify(EXAMPLES[index]!.filter, null, 2);
  run();
}

exampleSelect.addEventListener("change", () => showExample(Number(exampleSelect.value)));
filterInput.addEventListener("input", () => {
  exampleSelect.value = "";
  run();
});
showExample(0);
