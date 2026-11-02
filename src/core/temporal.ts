/**
 * Temporal Functions, as the package decides them: each relation of OWL-Time (the standard's tables) written on the
 * operands' ends, intervals closed at both ends, an instant the interval from it to itself, `'..'` unbounded. Shared by
 * `validate`, `evaluate` and `toSql`, which writes the same comparisons. Internal to the package.
 */
import type { TemporalOperator } from "./types.js";

/** An end of either operand: the first's begin and end, the second's. */
export type End = "b1" | "e1" | "b2" | "e2";

/** `left op right`, one comparison of two ends. */
export type EndComparison = readonly [End, "<" | "=" | ">" | "<=" | ">=", End];

/** Each relation as comparisons of the ends: any of the groups, each group all of its comparisons (OR of ANDs). */
export const RELATIONS: Readonly<Record<TemporalOperator, readonly (readonly EndComparison[])[]>> = {
  t_before: [[["e1", "<", "b2"]]],
  t_after: [[["b1", ">", "e2"]]],
  t_meets: [[["e1", "=", "b2"]]],
  t_metBy: [[["b1", "=", "e2"]]],
  t_overlaps: [[["b1", "<", "b2"], ["b2", "<", "e1"], ["e1", "<", "e2"]]],
  t_overlappedBy: [[["b2", "<", "b1"], ["b1", "<", "e2"], ["e2", "<", "e1"]]],
  t_starts: [[["b1", "=", "b2"], ["e1", "<", "e2"]]],
  t_startedBy: [[["b1", "=", "b2"], ["e1", ">", "e2"]]],
  t_during: [[["b1", ">", "b2"], ["e1", "<", "e2"]]],
  t_contains: [[["b1", "<", "b2"], ["e1", ">", "e2"]]],
  t_finishes: [[["b1", ">", "b2"], ["e1", "=", "e2"]]],
  t_finishedBy: [[["b1", "<", "b2"], ["e1", "=", "e2"]]],
  t_equals: [[["b1", "=", "b2"], ["e1", "=", "e2"]]],
  // T_DISJOINT is T_BEFORE OR T_AFTER, T_INTERSECTS NOT T_DISJOINT.
  t_disjoint: [[["e1", "<", "b2"]], [["b1", ">", "e2"]]],
  t_intersects: [[["b1", "<=", "e2"], ["e1", ">=", "b2"]]],
};

export const isTemporal = (op: string): op is TemporalOperator => Object.hasOwn(RELATIONS, op);

/** The relations of the standard's second table, defined for intervals only: an instant there is a client error. */
export const INTERVALS_ONLY: ReadonlySet<string> = new Set([
  "t_contains", "t_during", "t_finishedBy", "t_finishes", "t_meets", "t_metBy", "t_overlappedBy", "t_overlaps",
  "t_startedBy", "t_starts",
]);

/** `'..'`, an interval's unbounded end. */
export const OPEN = "..";

/** Whether the relation holds, given how each comparison of two ends comes out. */
export function holds(op: TemporalOperator, compare: (c: EndComparison) => boolean): boolean {
  return RELATIONS[op].some((group) => group.every(compare));
}
