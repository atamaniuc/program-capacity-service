import { sql } from 'kysely';
import type { CapacityReader, ReleaseSummary } from '#src/capacity/application/ports/index.js';
import { isUuid } from './reservation.repository.js';
import {
  toProgram,
  toReservation,
  type ProgramRow,
  type Queryable,
  type ReservationRow,
} from './rows.js';

/** Reads on the primary connection pool (FR-01: a client reads its own writes). */
export class PgCapacityReader implements CapacityReader {
  constructor(private readonly db: Queryable) {}

  async getProgram(tenantId: string, programId: string) {
    const { rows } = await sql<ProgramRow>`
      SELECT * FROM program WHERE tenant_id = ${tenantId} AND id = ${programId}`.execute(this.db);
    return rows[0] === undefined ? null : toProgram(rows[0]);
  }

  async getReservation(tenantId: string, programId: string, reservationId: string) {
    if (!isUuid(reservationId)) return null;
    const found = await sql<ReservationRow>`
      SELECT * FROM reservation
       WHERE id = ${reservationId}::uuid AND tenant_id = ${tenantId} AND program_id = ${programId}`.execute(
      this.db,
    );
    const row = found.rows[0];
    if (row === undefined) return null;
    const { rows } = await sql<{
      release_ref: string;
      reason: string;
      invoice_amount_minor: string;
      amount_minor: string;
      created_at: Date;
    }>`
      SELECT release_ref, reason, invoice_amount_minor, amount_minor, created_at
        FROM reservation_release
       WHERE reservation_id = ${reservationId}::uuid AND amount_minor IS NOT NULL
       ORDER BY created_at, id`.execute(this.db);
    const releases: ReleaseSummary[] = rows.map((release) => ({
      releaseRef: release.release_ref,
      reason: release.reason,
      invoiceMinor: BigInt(release.invoice_amount_minor),
      programMinor: BigInt(release.amount_minor),
      createdAt: release.created_at,
    }));
    return { reservation: toReservation(row), releases };
  }
}
