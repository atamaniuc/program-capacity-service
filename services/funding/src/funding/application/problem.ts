/** Problem types of the funding REST contract; clients branch on `type`, not on status. */
export type ProblemType =
  'idempotency-key-mismatch' | 'funding-request-conflict' | 'validation-error' | 'not-found';

export interface Problem {
  readonly type: ProblemType;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

const CATALOG: Readonly<Record<ProblemType, { title: string; status: number }>> = {
  'idempotency-key-mismatch': {
    title: 'Idempotency key reused with a different request',
    status: 422,
  },
  'funding-request-conflict': {
    title: 'A funding request for this invoice exists with other terms',
    status: 409,
  },
  'validation-error': { title: 'Validation error', status: 400 },
  'not-found': { title: 'Not found', status: 404 },
};

export const PROBLEM_TYPES = Object.keys(CATALOG) as ProblemType[];

export function problem(type: ProblemType, detail: string): Problem {
  const entry = CATALOG[type];
  return { type, title: entry.title, status: entry.status, detail };
}

/** A use case answers with a success value or a business problem; only the adapter speaks HTTP. */
export type Outcome<V> =
  | { readonly ok: true; readonly status: 200 | 202; readonly value: V }
  | { readonly ok: false; readonly problem: Problem };

export function succeeded<V>(status: 200 | 202, value: V): Outcome<V> {
  return { ok: true, status, value };
}

export function rejected<V = never>(type: ProblemType, detail: string): Outcome<V> {
  return { ok: false, problem: problem(type, detail) };
}

export function statusOf(outcome: Outcome<unknown>): number {
  return outcome.ok ? outcome.status : outcome.problem.status;
}
