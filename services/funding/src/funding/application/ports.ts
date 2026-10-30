import type { FundingState } from '../domain/index.js';
import type { Outcome } from './problem.js';

/** A funding request as the API shows it. */
export interface FundingRequestRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly state: FundingState;
  readonly reason: string | null;
  readonly reservationId: string | null;
  readonly paymentId: string | null;
  readonly createdAt: Date;
}

export interface NewFundingRequestRow {
  readonly tenantId: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
}

export interface StoredKey {
  readonly fingerprint: string;
  /** `null` only while the claiming transaction is still open. */
  readonly outcome: Outcome<unknown> | null;
}

/** Everything one use case does inside its single transaction (ADR 025, lock order: key, then row). */
export interface FundingTransaction {
  /** `INSERT … ON CONFLICT DO NOTHING`: false when the key exists (never `FOR UPDATE`). */
  claimKey(tenantId: string, key: string, fingerprint: string): Promise<boolean>;
  findKey(tenantId: string, key: string): Promise<StoredKey | null>;
  completeKey(
    tenantId: string,
    key: string,
    status: number,
    outcome: Outcome<unknown>,
  ): Promise<void>;
  /** Inserts in state RECEIVED; on the natural key returns the existing row with `created: false`. */
  insertRequest(
    row: NewFundingRequestRow,
  ): Promise<{ readonly record: FundingRequestRecord; readonly created: boolean }>;
  insertOutbox(
    tenantId: string,
    requestId: string,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  findRequest(tenantId: string, id: string): Promise<FundingRequestRecord | null>;
}

export interface UnitOfWork {
  run<T>(work: (tx: FundingTransaction) => Promise<T>): Promise<T>;
}
