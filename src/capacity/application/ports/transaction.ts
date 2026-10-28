import type { FxRate, LedgerEntry, Program, Reservation } from '#src/capacity/domain/index.js';
import type { Outcome } from '../shared/problem.js';

export interface ProgramRepository {
  /** `SELECT … FOR UPDATE` by (tenant, id). */
  lockForUpdate(tenantId: string, programId: string): Promise<Program | null>;
  /**
   * Adds `amountMinor` to reserved only if `limit − reserved ≥ amount` still holds, bumping
   * `version` and `platform_seq`. Null when the guard refuses (never expected under the lock).
   */
  reserve(tenantId: string, programId: string, amountMinor: bigint): Promise<Program | null>;
  /** Subtracts `amountMinor` from reserved, bumping `version` and `platform_seq`. */
  release(tenantId: string, programId: string, amountMinor: bigint): Promise<Program | null>;
}

export interface ReservationRepository {
  findByInvoice(
    tenantId: string,
    programId: string,
    invoiceId: string,
  ): Promise<Reservation | null>;
  /** Plain read used to verify ownership before the release dedup row is claimed. */
  exists(tenantId: string, programId: string, reservationId: string): Promise<boolean>;
  /** `SELECT … FOR UPDATE` by id, filtered by tenant and program. */
  lockById(tenantId: string, programId: string, reservationId: string): Promise<Reservation | null>;
  insert(reservation: Reservation): Promise<void>;
  applyRelease(change: {
    readonly id: string;
    readonly releasedMinor: bigint;
    readonly releasedInvoiceMinor: bigint;
    readonly status: Reservation['status'];
  }): Promise<void>;
}

export interface ReleaseRecord {
  readonly id: string;
  readonly releaseRef: string;
  readonly fingerprint: string;
  readonly reason: string;
  /** Null while the claiming transaction is still open. */
  readonly result: Outcome<unknown> | null;
}

export interface ReleaseRepository {
  /** INSERT … ON CONFLICT (reservation_id, release_ref) DO NOTHING; true when this call won. */
  claim(claim: {
    readonly id: string;
    readonly reservationId: string;
    readonly releaseRef: string;
    readonly fingerprint: string;
    readonly reason: string;
  }): Promise<boolean>;
  /** A new statement: sees the committed row of a winner this call waited for. */
  find(reservationId: string, releaseRef: string): Promise<ReleaseRecord | null>;
  complete(
    id: string,
    amounts: { readonly invoiceMinor: bigint; readonly programMinor: bigint },
    result: Outcome<unknown>,
  ): Promise<void>;
  /** Removes this transaction's own claim when the release is refused. */
  discard(id: string): Promise<void>;
}

export interface LedgerWriter {
  append(entry: LedgerEntry): Promise<void>;
}

export interface OutboxEvent {
  readonly tenantId: string;
  readonly programId: string;
  readonly programSeq: number;
  readonly type: 'ReservationCreated' | 'ReservationReleased';
  readonly payload: unknown;
}

export interface OutboxWriter {
  append(event: OutboxEvent): Promise<void>;
}

export interface FxQuote {
  readonly rate: FxRate;
  readonly source: string;
  readonly asOf: Date;
}

export interface FxRateReader {
  /** Newest rate for base → quote with `as_of > notBefore`, or null. */
  latest(base: string, quote: string, notBefore: Date): Promise<FxQuote | null>;
}

export interface StoredIdempotency {
  readonly fingerprint: string;
  readonly outcome: Outcome<unknown> | null;
}

export interface IdempotencyStore {
  /** INSERT … ON CONFLICT DO NOTHING RETURNING; never a row lock on the key. */
  claim(tenantId: string, key: string, fingerprint: string): Promise<boolean>;
  /** A new statement: reads the committed row left by a winner. */
  find(tenantId: string, key: string): Promise<StoredIdempotency | null>;
  complete(
    tenantId: string,
    key: string,
    statusCode: number,
    outcome: Outcome<unknown>,
  ): Promise<void>;
}

/** Everything one use case may touch inside its single transaction. */
export interface TransactionScope {
  readonly programs: ProgramRepository;
  readonly reservations: ReservationRepository;
  readonly releases: ReleaseRepository;
  readonly ledger: LedgerWriter;
  readonly outbox: OutboxWriter;
  readonly fxRates: FxRateReader;
  readonly idempotency: IdempotencyStore;
}

export interface UnitOfWork {
  /**
   * READ COMMITTED with transaction-local lock and statement timeouts. Commits when `work`
   * resolves (business rejections are values, not errors) and rolls back when it throws.
   */
  run<T>(work: (tx: TransactionScope) => Promise<T>): Promise<T>;
}
