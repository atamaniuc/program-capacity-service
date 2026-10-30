import { err, ok, type Result } from './result.js';
import type { Money } from './money.js';

export type FundingState =
  | 'RECEIVED'
  | 'RESERVING'
  | 'DISBURSING'
  | 'COMPENSATING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'FAILED'
  | 'NEEDS_ATTENTION';

/** No transition leaves these (ADR 025). NEEDS_ATTENTION is left only by an operator command. */
export const TERMINAL_STATES: readonly FundingState[] = ['COMPLETED', 'REJECTED', 'FAILED'];

export function isTerminal(state: FundingState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * One request to pay one supplier invoice early. The saga state is the fields of this value;
 * instants are epoch milliseconds from the database clock, passed in by the caller.
 */
export interface FundingRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly amount: Money;
  readonly state: FundingState;
  /** Why the request is REJECTED, FAILED, NEEDS_ATTENTION, or being compensated. */
  readonly reason?: string;
  /** Set only from a Reserve answered `CREATED` under the saga's own key. */
  readonly reservationId?: string;
  readonly paymentId?: string;
  /** Consecutive unknown outcomes of the current step; drives the backoff. */
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly reserveDeadlineAt?: number;
  readonly disburseDeadlineAt?: number;
  /** Set when the reserve deadline passes: the limit for resolving the unknown reservation. */
  readonly resolutionDeadlineAt?: number;
  readonly createdAt: number;
}

export type NewFundingRequest = Pick<
  FundingRequest,
  'id' | 'tenantId' | 'programId' | 'invoiceId' | 'amount'
>;

export type FundingRequestError = 'missing-field';

export function receiveFundingRequest(
  input: NewFundingRequest,
  now: number,
): Result<FundingRequest, FundingRequestError> {
  if (
    input.id === '' ||
    input.tenantId === '' ||
    input.programId === '' ||
    input.invoiceId === ''
  ) {
    return err('missing-field');
  }
  return ok({
    ...input,
    state: 'RECEIVED',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
  });
}
