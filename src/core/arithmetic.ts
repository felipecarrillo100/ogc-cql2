/**
 * Arithmetic Expressions, as the package computes them: with doubles; `div` the quotient rounded toward zero, `%` its
 * remainder `x − y × trunc(x / y)` (CQL2 leaves both open; these are operations every SQL engine computes bit for bit
 * alike, where an exact `fmod` isn't possible in PostgreSQL); a result that isn't a finite number is NULL. Shared by
 * `evaluate`, the `sqlite` dialect's function and `toSql`, which computes expressions of literals once. Internal to
 * the package.
 */
import type { ArithmeticExpression, ArithmeticOperator, NumericOperand, PropertyRef } from "./types.js";

export const OPERATORS: Readonly<Record<ArithmeticOperator, (a: number, b: number) => number>> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  div: (a, b) => Math.trunc(a / b),
  "%": (a, b) => a - b * Math.trunc(a / b),
  // C's pow, which PostgreSQL and DuckDB use: 1 to any power, and −1 to ±Infinity, are 1 (JavaScript says NaN).
  "^": (a, b) => (a === 1 || (a === -1 && (b === Infinity || b === -Infinity)) ? 1 : a ** b),
};

export const isArithmetic = (x: unknown): x is ArithmeticExpression =>
  typeof x === "object" && x !== null && "op" in x && Object.hasOwn(OPERATORS, (x as { op: string }).op);

/** One operation: NULL for a NULL operand, or when the result isn't a finite number. */
export function operate(op: ArithmeticOperator, a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const result = OPERATORS[op](a, b);
  return Number.isFinite(result) ? result : null;
}

/** Whether an expression reads a property. */
export const readsProperty = (x: NumericOperand): boolean =>
  typeof x === "object" && ("property" in x || x.args.some(readsProperty));

/** An expression's value, each property read with `read` (NULL when it isn't a number). */
export function compute(x: NumericOperand, read: (ref: PropertyRef) => number | null): number | null {
  if (typeof x === "number") return x;
  if (!isArithmetic(x)) return read(x);
  return operate(x.op, compute(x.args[0], read), compute(x.args[1], read));
}
