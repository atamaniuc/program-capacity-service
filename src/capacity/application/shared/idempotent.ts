import type { IdempotencyStore } from '../ports/transaction.js';
import { rejected, statusOf, type Outcome } from './problem.js';

export interface IdempotencyRequest {
  readonly tenantId: string;
  /** Absent: the natural keys still deduplicate, but no response is stored. */
  readonly key: string | undefined;
  readonly fingerprint: string;
}

/**
 * Runs `work` once per (tenant, key) (FR-04). The claim is an INSERT … ON CONFLICT DO NOTHING:
 * a duplicate waits for an in-flight winner at the unique index, never on a row lock. Business
 * rejections are outcomes like any other and are stored; an infrastructure error propagates and
 * rolls the claim back with the rest of the transaction.
 */
export async function idempotently<V>(
  store: IdempotencyStore,
  request: IdempotencyRequest,
  work: () => Promise<Outcome<V>>,
): Promise<Outcome<V>> {
  const { tenantId, key, fingerprint } = request;
  if (key === undefined) return work();
  if (!(await store.claim(tenantId, key, fingerprint))) {
    const stored = await store.find(tenantId, key);
    if (stored === null || stored.outcome === null) {
      throw new Error('idempotency key was claimed but has no committed response');
    }
    if (stored.fingerprint !== fingerprint) {
      return rejected(
        'idempotency-key-mismatch',
        'The Idempotency-Key was already used with a different request.',
      );
    }
    return stored.outcome as Outcome<V>;
  }
  const outcome = await work();
  await store.complete(tenantId, key, statusOf(outcome), outcome);
  return outcome;
}
