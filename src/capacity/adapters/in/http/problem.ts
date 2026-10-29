import type { Problem } from '#src/capacity/application/shared/problem.js';
import {
  PROBLEM_MAP,
  type BoundaryProblem,
  type TransportProblemType,
} from '../boundary/problem.js';
import { PROBLEM_TYPE_BASE } from '../boundary/schemas.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** RFC 9457 body: a type URI, a title, the status and a detail free of internals. */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

export function problemBody(
  problem: Pick<Problem, 'title' | 'status' | 'detail'> & { type: TransportProblemType },
): ProblemBody {
  return {
    type: `${PROBLEM_TYPE_BASE}${problem.type}`,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
  };
}

/** Thrown by guards and controllers; the filter turns it into `application/problem+json`. */
export class HttpProblem extends Error {
  readonly problem: ProblemBody;

  constructor(
    type: TransportProblemType,
    title: string,
    readonly status: number,
    detail: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail);
    this.problem = problemBody({ type, title, status, detail });
  }
}

function fromTable(
  type: TransportProblemType,
  detail: string,
  headers: Readonly<Record<string, string>> = {},
): HttpProblem {
  const { title, http } = PROBLEM_MAP[type];
  return new HttpProblem(type, title, http, detail, headers);
}

export const unauthorized = (detail: string): HttpProblem =>
  fromTable('unauthorized', detail, { 'WWW-Authenticate': 'Bearer' });

export const forbidden = (detail: string): HttpProblem => fromTable('forbidden', detail);

export const serviceUnavailable = (detail: string): HttpProblem =>
  fromTable('service-unavailable', detail, { 'Retry-After': '1' });

/** The HTTP form of a problem raised at the boundary: status from the table, challenge headers. */
export function fromBoundary(problem: BoundaryProblem): HttpProblem {
  if (problem.type === 'unauthorized') return unauthorized(problem.detail);
  if (problem.type === 'service-unavailable') return serviceUnavailable(problem.detail);
  return fromTable(problem.type, problem.detail);
}
