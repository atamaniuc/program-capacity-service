import { sql } from 'kysely';
import type {
  InvariantMismatch,
  MaintenanceStore,
  RetentionPolicy,
  RetentionResult,
} from '#src/capacity/application/ports/index.js';
import type { Queryable } from './rows.js';

/** Read-mostly maintenance queries for the worker's scheduled jobs. */
export class PgMaintenanceStore implements MaintenanceStore {
  constructor(private readonly db: Queryable) {}

  async findInvariantMismatches(): Promise<readonly InvariantMismatch[]> {
    const { rows } = await sql<{
      tenant_id: string;
      id: string;
      reserved_minor: string;
      reservations_minor: string;
      ledger_minor: string;
    }>`
      SELECT tenant_id, id, reserved_minor, reservations_minor, ledger_minor
        FROM (
          SELECT p.tenant_id, p.id, p.reserved_minor,
                 COALESCE((SELECT sum(r.amount_minor - r.released_minor) FROM reservation r
                            WHERE r.tenant_id = p.tenant_id AND r.program_id = p.id
                              AND r.status <> 'RELEASED'), 0) AS reservations_minor,
                 COALESCE((SELECT sum(l.delta_reserved_minor) FROM ledger_entry l
                            WHERE l.tenant_id = p.tenant_id AND l.program_id = p.id), 0) AS ledger_minor
            FROM program p) totals
       WHERE reserved_minor <> reservations_minor OR reserved_minor <> ledger_minor
       ORDER BY tenant_id, id`.execute(this.db);
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      programId: row.id,
      reservedMinor: BigInt(row.reserved_minor),
      reservationsMinor: BigInt(row.reservations_minor),
      ledgerMinor: BigInt(row.ledger_minor),
    }));
  }

  async deleteExpired(policy: RetentionPolicy): Promise<RetentionResult> {
    const idempotency = await sql`
      DELETE FROM idempotency_key
       WHERE created_at < now() - make_interval(secs => ${policy.idempotencyKeyMaxAgeSeconds})`.execute(
      this.db,
    );
    const inbox = await sql`
      DELETE FROM inbox_message
       WHERE processed_at < now() - make_interval(secs => ${policy.inboxMaxAgeSeconds})`.execute(
      this.db,
    );
    const outbox = await sql`
      DELETE FROM outbox_event
       WHERE published_at IS NOT NULL
         AND published_at < now() - make_interval(secs => ${policy.outboxPublishedMaxAgeSeconds})`.execute(
      this.db,
    );
    return {
      idempotencyKeys: Number(idempotency.numAffectedRows ?? 0n),
      inboxMessages: Number(inbox.numAffectedRows ?? 0n),
      outboxEvents: Number(outbox.numAffectedRows ?? 0n),
    };
  }
}
