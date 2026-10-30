import { CQL2_VERSION } from "ogc-cql2";
import { quoteString } from "ogc-cql2/text";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const input = byId<HTMLInputElement>("value");
const literal = byId<HTMLOutputElement>("literal");

byId("version").textContent = CQL2_VERSION;

function show(): void {
  literal.textContent = quoteString(input.value);
}

input.addEventListener("input", show);
show();
