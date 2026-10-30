import { formatMoney, parseMoney } from '../domain/index.js';
import { fingerprintOf } from './fingerprint.js';
import { rejected, statusOf, succeeded, type Outcome } from './problem.js';
import type { FundingRequestRecord, UnitOfWork, FundingTransaction } from './ports.js';

export interface FundingRequestView {
  readonly id: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly amount: { readonly value: string; readonly currency: string };
  readonly state: string;
  readonly reason: string | null;
  readonly reservationId: string | null;
  readonly paymentId: string | null;
  readonly createdAt: string;
}

export function toView(record: FundingRequestRecord): FundingRequestView {
  return {
    id: record.id,
    programId: record.programId,
    invoiceId: record.invoiceId,
    amount: {
      value: formatMoney({ minor: record.amountMinor, currency: record.currency }),
      currency: record.currency,
    },
    state: record.state,
    reason: record.reason,
    reservationId: record.reservationId,
    paymentId: record.paymentId,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface CreateFundingRequestInput {
  readonly tenantId: string;
  readonly idempotencyKey: string | undefined;
  readonly programId: string;
  readonly invoiceId: string;
  readonly amount: { readonly value: string; readonly currency: string };
}

/**
 * Runs `work` once per (tenant, key) (ADR 006). The claim is an INSERT … ON CONFLICT DO NOTHING:
 * a duplicate waits for an in-flight winner at the unique index, never on a row lock.
 */
async function idempotently(
  tx: FundingTransaction,
  tenantId: string,
  key: string | undefined,
  fingerprint: string,
  work: () => Promise<Outcome<FundingRequestView>>,
): Promise<Outcome<FundingRequestView>> {
  if (key === undefined) return work();
  if (!(await tx.claimKey(tenantId, key, fingerprint))) {
    const stored = await tx.findKey(tenantId, key);
    if (stored === null || stored.outcome === null) {
      throw new Error('idempotency key was claimed but has no committed response');
    }
    if (stored.fingerprint !== fingerprint) {
      return rejected(
        'idempotency-key-mismatch',
        'The Idempotency-Key was already used with a different request.',
      );
    }
    return stored.outcome as Outcome<FundingRequestView>;
  }
  const outcome = await work();
  await tx.completeKey(tenantId, key, statusOf(outcome), outcome);
  return outcome;
}

/** `POST /v1/funding-requests`: records the request as RECEIVED; the saga driver does the rest. */
export class CreateFundingRequest {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(input: CreateFundingRequestInput): Promise<Outcome<FundingRequestView>> {
    const parsed = parseMoney(input.amount.value, input.amount.currency);
    if (!parsed.ok) {
      return rejected('validation-error', `The amount is invalid: ${parsed.error}.`);
    }
    const amount = parsed.value;
    const fingerprint = fingerprintOf({
      op: 'create-funding-request',
      programId: input.programId,
      invoiceId: input.invoiceId,
      amountMinor: amount.minor.toString(),
      currency: amount.currency,
    });
    return this.uow.run((tx) =>
      idempotently(tx, input.tenantId, input.idempotencyKey, fingerprint, async () => {
        const { record, created } = await tx.insertRequest({
          tenantId: input.tenantId,
          programId: input.programId,
          invoiceId: input.invoiceId,
          currency: amount.currency,
          amountMinor: amount.minor,
        });
        if (created) {
          await tx.insertOutbox(input.tenantId, record.id, 'FundingRequestReceived', {
            fundingRequestId: record.id,
            programId: record.programId,
            invoiceId: record.invoiceId,
            amount: toView(record).amount,
          });
          return succeeded(202, toView(record));
        }
        if (record.currency !== amount.currency || record.amountMinor !== amount.minor) {
          return rejected(
            'funding-request-conflict',
            'A funding request for this invoice already exists with a different amount.',
          );
        }
        return succeeded(200, toView(record));
      }),
    );
  }
}

/** `GET /v1/funding-requests/{id}`; another tenant's request is simply not found. */
export class GetFundingRequest {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(tenantId: string, id: string): Promise<Outcome<FundingRequestView>> {
    const record = await this.uow.run((tx) => tx.findRequest(tenantId, id));
    return record === null
      ? rejected('not-found', 'No such funding request.')
      : succeeded(200, toView(record));
  }
}
