import {
  PROBLEM_TYPES,
  type Problem,
  type ProblemType,
} from '#src/capacity/application/shared/problem.js';
import { PROBLEM_TYPE_BASE } from './schemas.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Problems the transport adds on top of the business catalog. */
export type TransportProblemType =
  | ProblemType
  | 'unauthorized'
  | 'forbidden'
  | 'payload-too-large'
  | 'internal-error'
  | 'service-unavailable';

export const TRANSPORT_PROBLEM_TYPES: readonly TransportProblemType[] = [
  ...PROBLEM_TYPES,
  'unauthorized',
  'forbidden',
  'payload-too-large',
  'internal-error',
  'service-unavailable',
];

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

export const unauthorized = (detail: string): HttpProblem =>
  new HttpProblem('unauthorized', 'Unauthorized', 401, detail, { 'WWW-Authenticate': 'Bearer' });

export const forbidden = (detail: string): HttpProblem =>
  new HttpProblem('forbidden', 'Forbidden', 403, detail);

export const validationProblem = (detail: string): HttpProblem =>
  new HttpProblem('validation-error', 'Validation error', 400, detail);

export const serviceUnavailable = (detail: string): HttpProblem =>
  new HttpProblem('service-unavailable', 'Service unavailable', 503, detail, {
    'Retry-After': '1',
  });
