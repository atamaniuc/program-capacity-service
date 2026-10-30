/** Saga steps that make a call with an idempotency key (ADR 025). */
export type KeyedStep = 'reserve' | 'disburse' | 'release';

/** `funding:<id>:<step>`: derived from the request id and the step, never per attempt. */
export function stepKey(requestId: string, step: KeyedStep): string {
  return `funding:${requestId}:${step}`;
}

/** The natural key of the compensating release in capacity (`release_ref`, permanent). */
export function compensationRef(requestId: string): string {
  return `funding:${requestId}:compensation`;
}
