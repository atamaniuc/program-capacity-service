import { sql } from 'kysely';
import type { ReservationRepository } from '#src/capacity/application/ports/index.js';
import { formatFxRate, type Reservation } from '#src/capacity/domain/index.js';
import { toReservation, type Queryable, type ReservationRow } from './rows.js';

export class PgReservationRepository implements ReservationRepository {
  constructor(private readonly db: Queryable) {}

  async findByInvoice(tenantId: string, programId: string, invoiceId: string) {
    const { rows } = await sql<ReservationRow>`
      SELECT * FROM reservation
       WHERE tenant_id = ${tenantId} AND program_id = ${programId} AND invoice_id = ${invoiceId}`.execute(
      this.db,
    );
    return rows[0] === undefined ? null : toReservation(rows[0]);
  }

  async exists(tenantId: string, programId: string, reservationId: string) {
    if (!isUuid(reservationId)) return false;
    const { rows } = await sql`
      SELECT 1 FROM reservation
       WHERE id = ${reservationId}::uuid AND tenant_id = ${tenantId} AND program_id = ${programId}`.execute(
      this.db,
    );
    return rows.length > 0;
  }

  async lockById(tenantId: string, programId: string, reservationId: string) {
    if (!isUuid(reservationId)) return null;
    const { rows } = await sql<ReservationRow>`
      SELECT * FROM reservation
       WHERE id = ${reservationId}::uuid AND tenant_id = ${tenantId} AND program_id = ${programId}
         FOR UPDATE`.execute(this.db);
    return rows[0] === undefined ? null : toReservation(rows[0]);
  }

  async insert(reservation: Reservation) {
    await sql`
      INSERT INTO reservation (
        id, tenant_id, program_id, invoice_id, invoice_amount_minor, invoice_currency,
        fx_rate, fx_rate_source, fx_rate_at, amount_minor, released_minor, released_invoice_minor,
        status, origin, platform_seq, created_at, updated_at)
      VALUES (
        ${reservation.id}::uuid, ${reservation.tenantId}, ${reservation.programId},
        ${reservation.invoiceId}, ${reservation.invoiceAmount.minor.toString()}::bigint,
        ${reservation.invoiceAmount.currency}, ${formatFxRate(reservation.fx.rate)}::numeric,
        ${reservation.fx.source}, ${reservation.fx.at}, ${reservation.amountMinor.toString()}::bigint,
        ${reservation.releasedMinor.toString()}::bigint,
        ${reservation.releasedInvoiceMinor.toString()}::bigint,
        ${reservation.status}, ${reservation.origin}, ${reservation.platformSeq},
        ${reservation.createdAt}, ${reservation.createdAt})`.execute(this.db);
  }

  async applyRelease(change: {
    id: string;
    releasedMinor: bigint;
    releasedInvoiceMinor: bigint;
    status: Reservation['status'];
  }) {
    await sql`
      UPDATE reservation
         SET released_minor = ${change.releasedMinor.toString()}::bigint,
             released_invoice_minor = ${change.releasedInvoiceMinor.toString()}::bigint,
             status = ${change.status},
             updated_at = now()
       WHERE id = ${change.id}::uuid`.execute(this.db);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never match; asking PostgreSQL to cast it would raise instead. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
