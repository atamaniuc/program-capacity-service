import {
  problem as businessProblem,
  type Problem,
  type ProblemType,
} from '../../../application/problem.js';
import { PROBLEM_TYPE_BASE } from './schemas.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type TransportProblemType =
  | ProblemType
  | 'unauthorized'
  | 'forbidden'
  | 'method-not-allowed'
  | 'payload-too-large'
  | 'internal-error'
  | 'service-unavailable';

const TRANSPORT: Readonly<
  Record<Exclude<TransportProblemType, ProblemType>, { title: string; status: number }>
> = {
  unauthorized: { title: 'Unauthorized', status: 401 },
  forbidden: { title: 'Forbidden', status: 403 },
  'method-not-allowed': { title: 'Method not allowed', status: 405 },
  'payload-too-large': { title: 'Payload too large', status: 413 },
  'internal-error': { title: 'Internal error', status: 500 },
  'service-unavailable': { title: 'Service unavailable', status: 503 },
};

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

/** Thrown by guards; the server turns it into `application/problem+json`. */
export class HttpProblem extends Error {
  private constructor(
    readonly problem: ProblemBody,
    readonly headers: Readonly<Record<string, string>>,
  ) {
    super(problem.detail);
  }

  static of(
    type: Exclude<TransportProblemType, ProblemType>,
    detail: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): HttpProblem {
    const entry = TRANSPORT[type];
    const headers: Record<string, string> = { ...extraHeaders };
    if (type === 'unauthorized') headers['WWW-Authenticate'] = 'Bearer';
    if (type === 'service-unavailable') headers['Retry-After'] = '1';
    return new HttpProblem(problemBody({ type, ...entry, detail }), headers);
  }

  static business(type: ProblemType, detail: string): HttpProblem {
    return new HttpProblem(problemBody(businessProblem(type, detail)), {});
  }
}
