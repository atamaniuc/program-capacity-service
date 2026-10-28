export type LedgerKind = 'RESERVE' | 'RELEASE' | 'LIMIT_SET' | 'RECON_ADJUST';

/** Immutable record of one change to the limit or to reserved (FR-11, I5). */
export interface LedgerEntry {
  readonly tenantId: string;
  readonly programId: string;
  readonly reservationId: string | null;
  readonly kind: LedgerKind;
  readonly deltaReservedMinor: bigint;
  readonly deltaLimitMinor: bigint;
  readonly limitAfter: bigint;
  readonly reservedAfter: bigint;
  readonly causeType: string;
  readonly causeId: string;
  readonly actor: string;
}
