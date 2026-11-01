/** Refusals as `application/problem+json` (RFC 9457), with a stable `code` and, for a filter, its problems. */
import type { Response } from "express";

export interface ProblemDetails {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly problems?: readonly unknown[];
  /** For CQL2-text that isn't: where in the text, as a UTF-16 index. */
  readonly position?: number;
}

export function sendProblem(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).type("application/problem+json").send(JSON.stringify({ type: "about:blank", ...problem }));
}
