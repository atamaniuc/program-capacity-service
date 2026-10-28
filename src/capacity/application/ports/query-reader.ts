import type {
  LedgerKind,
  Program,
  Reservation,
  ReservationStatus,
} from '#src/capacity/domain/index.js';

/** A stored ledger row as the read side sees it. */
export interface LedgerRecord {
  readonly id: bigint;
  readonly reservationId: string | null;
  readonly kind: LedgerKind;
  readonly deltaReservedMinor: bigint;
  readonly deltaLimitMinor: bigint;
  readonly limitAfter: bigint;
  readonly reservedAfter: bigint;
  readonly causeType: string;
  readonly causeId: string;
  readonly actor: string;
  readonly createdAt: Date;
}

/** Keyset-paged reads for FR-12; always tenant- and program-scoped, always on the primary. */
export interface QueryReader {
  getProgram(tenantId: string, programId: string): Promise<Program | null>;
  /** Reservations ordered by id (UUIDv7, so by creation time), strictly after `afterId`. */
  listReservations(query: {
    readonly tenantId: string;
    readonly programId: string;
    readonly invoiceId?: string;
    readonly status?: ReservationStatus;
    readonly limit: number;
    readonly afterId?: string;
  }): Promise<readonly Reservation[]>;
  /** Ledger entries ordered by their identity id, strictly after `afterId`. */
  listLedger(query: {
    readonly tenantId: string;
    readonly programId: string;
    readonly limit: number;
    readonly afterId?: bigint;
  }): Promise<readonly LedgerRecord[]>;
}
