/** Problem types of the REST contract (PRD §9); clients branch on `type`, not on status. */
export type ProblemType =
  | 'insufficient-capacity'
  | 'program-over-limit'
  | 'program-suspended'
  | 'fx-rate-unavailable'
  | 'reservation-conflict'
  | 'idempotency-key-mismatch'
  | 'release-ref-mismatch'
  | 'release-exceeds-remaining'
  | 'validation-error'
  | 'not-found';

export interface Problem {
  readonly type: ProblemType;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

const CATALOG: Readonly<Record<ProblemType, { title: string; status: number }>> = {
  'insufficient-capacity': { title: 'Insufficient capacity', status: 422 },
  'program-over-limit': { title: 'Program is over its limit', status: 422 },
  'program-suspended': { title: 'Program is suspended', status: 422 },
  'fx-rate-unavailable': { title: 'FX rate unavailable', status: 422 },
  'reservation-conflict': { title: 'Reservation conflict', status: 409 },
  'idempotency-key-mismatch': {
    title: 'Idempotency key reused with a different request',
    status: 422,
  },
  'release-ref-mismatch': {
    title: 'Release reference reused with a different release',
    status: 422,
  },
  'release-exceeds-remaining': { title: 'Release exceeds the remaining amount', status: 422 },
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
  | { readonly ok: true; readonly status: 200 | 201; readonly value: V }
  | { readonly ok: false; readonly problem: Problem };

export function succeeded<V>(status: 200 | 201, value: V): Outcome<V> {
  return { ok: true, status, value };
}

export function rejected<V = never>(type: ProblemType, detail: string): Outcome<V> {
  return { ok: false, problem: problem(type, detail) };
}

export function statusOf(outcome: Outcome<unknown>): number {
  return outcome.ok ? outcome.status : outcome.problem.status;
}
