import type { LedgerEntry, Program, Reservation, FxRate } from '#src/capacity/domain/index.js';
import type { TransactionScope } from './transaction.js';
import type { MessageSource } from '../shared/treasury-errors.js';

/** Kafka dedup (I6): one row per (consumer, message id). */
export interface InboxStore {
  /** INSERT … ON CONFLICT DO NOTHING RETURNING; false when the message was already processed. */
  claim(source: MessageSource, messageId: string): Promise<boolean>;
  /** Plain read, used to skip expensive preparation for a message that is already processed. */
  seen(consumer: string, messageId: string): Promise<boolean>;
}

export interface TreasuryChange {
  readonly creditLimitMinor?: bigint | undefined;
  readonly status?: Program['status'] | undefined;
  readonly reservedDeltaMinor?: bigint | undefined;
  readonly treasurySeq: number;
}

export interface TreasuryProgramRepository {
  /** Plain read without a row lock. */
  find(tenantId: string, programId: string): Promise<Program | null>;
  /** INSERT … ON CONFLICT DO NOTHING: an ACTIVE program with nothing reserved. */
  createIfMissing(program: {
    readonly tenantId: string;
    readonly id: string;
    readonly currency: string;
  }): Promise<void>;
  /**
   * Applies a treasury change under the program lock and bumps `version` and `platform_seq`,
   * because every change emits one platform event. Sets `treasury_seq` (I7).
   */
  applyChange(tenantId: string, programId: string, change: TreasuryChange): Promise<Program>;
  /** Records the sequence of a message that changed nothing else. */
  markTreasurySeq(tenantId: string, programId: string, treasurySeq: number): Promise<void>;
}

/** One reservation as reconciliation sees it. */
export interface OwnReservation {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceCurrency: string;
  readonly invoiceAmountMinor: bigint;
  readonly releasedInvoiceMinor: bigint;
  readonly amountMinor: bigint;
  readonly releasedMinor: bigint;
  readonly status: Reservation['status'];
  readonly platformSeq: number;
  readonly createdAt: Date;
}

export interface ReservationOverwrite {
  readonly id: string;
  readonly invoiceAmountMinor: bigint;
  readonly amountMinor: bigint;
  readonly releasedInvoiceMinor: bigint;
  readonly releasedMinor: bigint;
  readonly status: Reservation['status'];
}

/** One snapshot reservation as it is loaded into the reconciliation staging table. */
export interface SnapshotRow {
  readonly invoiceId: string;
  readonly invoiceCurrency: string;
  readonly outstandingInvoiceMinor: bigint;
  readonly outstandingProgramMinor: bigint;
}

/**
 * One row of the set-based comparison between the staged snapshot and the reservations.
 * `both` carries a reservation and its snapshot row, `snapshot-only` only the snapshot row,
 * `ours-only` only the reservation.
 */
export interface ReconciliationDiffRow {
  readonly side: 'both' | 'snapshot-only' | 'ours-only';
  readonly reservation: OwnReservation | null;
  readonly snapshot: SnapshotRow | null;
}

export interface TreasuryReservationRepository {
  /** Plain read of every reservation of a program, no row locks. */
  listForProgram(tenantId: string, programId: string): Promise<readonly OwnReservation[]>;
  /** Replaces the staged snapshot rows of a program with one set-based DELETE + INSERT. */
  loadSnapshot(tenantId: string, programId: string, rows: readonly SnapshotRow[]): Promise<void>;
  /** Set-based comparison of the staged snapshot with the reservations, outside the program lock. */
  diff(tenantId: string, programId: string): Promise<readonly ReconciliationDiffRow[]>;
  /** One set-based UPDATE for every row, scoped to the locked program (PRD §8). */
  overwrite(
    tenantId: string,
    programId: string,
    rows: readonly ReservationOverwrite[],
  ): Promise<void>;
  /** One set-based INSERT for the reservations treasury knows and we do not. */
  insertMany(rows: readonly Reservation[]): Promise<void>;
}

export interface FxRateWriter {
  /** Stores a rate; the reader takes the newest `as_of`, so an older rate arriving late is inert. */
  upsert(rate: {
    readonly base: string;
    readonly quote: string;
    readonly rate: FxRate;
    readonly source: string;
    readonly asOf: Date;
  }): Promise<boolean>;
}

export interface LedgerBatchWriter {
  appendMany(entries: readonly LedgerEntry[]): Promise<void>;
}

export interface TreasuryScope extends TransactionScope {
  readonly inbox: InboxStore;
  readonly treasuryPrograms: TreasuryProgramRepository;
  readonly treasuryReservations: TreasuryReservationRepository;
  readonly fxWriter: FxRateWriter;
  readonly ledgerBatch: LedgerBatchWriter;
}

export interface TreasuryUnitOfWork {
  run<T>(work: (tx: TreasuryScope) => Promise<T>): Promise<T>;
}
