import { sql } from 'kysely';
import type { LedgerRecord, QueryReader } from '#src/capacity/application/ports/index.js';
import type { LedgerKind } from '#src/capacity/domain/index.js';
import {
  toProgram,
  toReservation,
  type ProgramRow,
  type Queryable,
  type ReservationRow,
} from './rows.js';

interface LedgerRow {
  id: string;
  reservation_id: string | null;
  kind: string;
  delta_reserved_minor: string;
  delta_limit_minor: string;
  limit_after: string;
  reserved_after: string;
  cause_type: string;
  cause_id: string;
  actor: string;
  created_at: Date;
}

/** FR-12 reads: keyset pagination on the primary, every query filtered by tenant and program. */
export class PgQueryReader implements QueryReader {
  constructor(private readonly db: Queryable) {}

  async getProgram(tenantId: string, programId: string) {
    const { rows } = await sql<ProgramRow>`
      SELECT * FROM program WHERE tenant_id = ${tenantId} AND id = ${programId}`.execute(this.db);
    return rows[0] === undefined ? null : toProgram(rows[0]);
  }

  async listReservations(query: Parameters<QueryReader['listReservations']>[0]) {
    const { rows } = await sql<ReservationRow>`
      SELECT * FROM reservation
       WHERE tenant_id = ${query.tenantId} AND program_id = ${query.programId}
         AND (${query.invoiceId ?? null}::text IS NULL OR invoice_id = ${query.invoiceId ?? null})
         AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
         AND (${query.afterId ?? null}::uuid IS NULL OR id > ${query.afterId ?? null}::uuid)
       ORDER BY id
       LIMIT ${query.limit}`.execute(this.db);
    return rows.map(toReservation);
  }

  async listLedger(query: Parameters<QueryReader['listLedger']>[0]) {
    const { rows } = await sql<LedgerRow>`
      SELECT id, reservation_id, kind, delta_reserved_minor, delta_limit_minor, limit_after,
             reserved_after, cause_type, cause_id, actor, created_at
        FROM ledger_entry
       WHERE tenant_id = ${query.tenantId} AND program_id = ${query.programId}
         AND (${query.afterId?.toString() ?? null}::bigint IS NULL
              OR id > ${query.afterId?.toString() ?? null}::bigint)
       ORDER BY id
       LIMIT ${query.limit}`.execute(this.db);
    return rows.map((row): LedgerRecord => ({
      id: BigInt(row.id),
      reservationId: row.reservation_id,
      kind: row.kind as LedgerKind,
      deltaReservedMinor: BigInt(row.delta_reserved_minor),
      deltaLimitMinor: BigInt(row.delta_limit_minor),
      limitAfter: BigInt(row.limit_after),
      reservedAfter: BigInt(row.reserved_after),
      causeType: row.cause_type,
      causeId: row.cause_id,
      actor: row.actor,
      createdAt: row.created_at,
    }));
  }
}
