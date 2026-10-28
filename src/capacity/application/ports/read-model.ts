import type { Program, Reservation } from '#src/capacity/domain/index.js';

export interface ReleaseSummary {
  readonly releaseRef: string;
  readonly reason: string;
  readonly invoiceMinor: bigint;
  readonly programMinor: bigint;
  readonly createdAt: Date;
}

/** Reads go to the primary, so a client reads its own writes (FR-01). */
export interface CapacityReader {
  getProgram(tenantId: string, programId: string): Promise<Program | null>;
  getReservation(
    tenantId: string,
    programId: string,
    reservationId: string,
  ): Promise<{
    readonly reservation: Reservation;
    readonly releases: readonly ReleaseSummary[];
  } | null>;
}
