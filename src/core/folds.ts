/**
 * `CASEI` and `ACCENTI` around a property or a string: what they wrap, and in which order. Internal to the package.
 */
import type { FoldedString, PropertyRef, StringSubject } from "./types.js";

/** A string function of CQL2 that folds text. */
export type Fold = "casei" | "accenti";

const isFold = (x: unknown): x is { op: Fold; args: readonly [unknown] } =>
  typeof x === "object" && x !== null && "op" in x && (x.op === "casei" || x.op === "accenti");

/** The property or string inside, and the folds applied to it, innermost first: `CASEI(ACCENTI(x))` → accenti, casei. */
export function unwrap(x: StringSubject): { readonly inner: PropertyRef; readonly folds: readonly Fold[] };
export function unwrap(x: string | FoldedString): { readonly inner: string; readonly folds: readonly Fold[] };
export function unwrap(x: unknown): { readonly inner: unknown; readonly folds: readonly Fold[] } {
  const folds: Fold[] = [];
  while (isFold(x)) {
    folds.unshift(x.op);
    x = x.args[0];
  }
  return { inner: x, folds };
}
