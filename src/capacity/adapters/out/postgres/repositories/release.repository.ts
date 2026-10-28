import { sql } from 'kysely';
import type { ReleaseRecord, ReleaseRepository } from '#src/capacity/application/ports/index.js';
import type { Outcome } from '#src/capacity/application/shared/problem.js';
import type { Queryable } from './rows.js';

export class PgReleaseRepository implements ReleaseRepository {
  constructor(private readonly db: Queryable) {}

  /** The unique (reservation_id, release_ref) index makes a concurrent duplicate wait here. */
  async claim(claim: {
    id: string;
    reservationId: string;
    releaseRef: string;
    fingerprint: string;
    reason: string;
  }) {
    const { rows } = await sql`
      INSERT INTO reservation_release (id, reservation_id, release_ref, fingerprint, reason)
      VALUES (${claim.id}::uuid, ${claim.reservationId}::uuid, ${claim.releaseRef},
              ${claim.fingerprint}, ${claim.reason})
      ON CONFLICT (reservation_id, release_ref) DO NOTHING
      RETURNING id`.execute(this.db);
    return rows.length > 0;
  }

  async find(reservationId: string, releaseRef: string): Promise<ReleaseRecord | null> {
    const { rows } = await sql<{
      id: string;
      release_ref: string;
      fingerprint: string;
      reason: string;
      result: Outcome<unknown> | null;
    }>`
      SELECT id, release_ref, fingerprint, reason, result FROM reservation_release
       WHERE reservation_id = ${reservationId}::uuid AND release_ref = ${releaseRef}`.execute(
      this.db,
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          releaseRef: row.release_ref,
          fingerprint: row.fingerprint,
          reason: row.reason,
          result: row.result,
        };
  }

  async complete(
    id: string,
    amounts: { invoiceMinor: bigint; programMinor: bigint },
    result: Outcome<unknown>,
  ) {
    await sql`
      UPDATE reservation_release
         SET invoice_amount_minor = ${amounts.invoiceMinor.toString()}::bigint,
             amount_minor = ${amounts.programMinor.toString()}::bigint,
             result = ${JSON.stringify(result)}::jsonb
       WHERE id = ${id}::uuid`.execute(this.db);
  }

  async discard(id: string) {
    await sql`DELETE FROM reservation_release WHERE id = ${id}::uuid`.execute(this.db);
  }
}
