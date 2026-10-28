import { sql } from 'kysely';
import type {
  LedgerWriter,
  OutboxEvent,
  OutboxWriter,
} from '#src/capacity/application/ports/index.js';
import type { LedgerEntry } from '#src/capacity/domain/index.js';
import type { Queryable } from './rows.js';

export class PgLedgerWriter implements LedgerWriter {
  constructor(private readonly db: Queryable) {}

  async append(entry: LedgerEntry) {
    await sql`
      INSERT INTO ledger_entry (
        tenant_id, program_id, reservation_id, kind, delta_reserved_minor, delta_limit_minor,
        limit_after, reserved_after, cause_type, cause_id, actor)
      VALUES (
        ${entry.tenantId}, ${entry.programId}, ${entry.reservationId}::uuid, ${entry.kind},
        ${entry.deltaReservedMinor.toString()}::bigint, ${entry.deltaLimitMinor.toString()}::bigint,
        ${entry.limitAfter.toString()}::bigint, ${entry.reservedAfter.toString()}::bigint,
        ${entry.causeType}, ${entry.causeId}, ${entry.actor})`.execute(this.db);
  }
}

export class PgOutboxWriter implements OutboxWriter {
  constructor(private readonly db: Queryable) {}

  async append(event: OutboxEvent) {
    await sql`
      INSERT INTO outbox_event (tenant_id, program_id, program_seq, type, payload)
      VALUES (${event.tenantId}, ${event.programId}, ${event.programSeq}, ${event.type},
              ${JSON.stringify(event.payload)}::jsonb)`.execute(this.db);
  }
}
