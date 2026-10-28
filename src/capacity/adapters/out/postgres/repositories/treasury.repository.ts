import { sql } from 'kysely';
import type {
  FxRateWriter,
  InboxStore,
  LedgerBatchWriter,
  OwnReservation,
  ReconciliationDiffRow,
  ReservationOverwrite,
  SnapshotRow,
  SnapshotStage,
  TreasuryChange,
  TreasuryProgramRepository,
  TreasuryReservationRepository,
} from '#src/capacity/application/ports/index.js';
import type { MessageSource } from '#src/capacity/application/shared/treasury-errors.js';
import {
  formatFxRate,
  type FxRate,
  type LedgerEntry,
  type Reservation,
} from '#src/capacity/domain/index.js';
import { toProgram, type ProgramRow, type Queryable } from './rows.js';

const text = (value: bigint | number): string => value.toString();

export class PgInboxStore implements InboxStore {
  constructor(private readonly db: Queryable) {}

  async claim(source: MessageSource, messageId: string) {
    const { rows } = await sql`
      INSERT INTO inbox_message (consumer, message_id, topic, "partition", "offset")
      VALUES (${source.consumer}, ${messageId}, ${source.topic}, ${source.partition},
              ${text(source.offset)}::bigint)
      ON CONFLICT (consumer, message_id) DO NOTHING
      RETURNING message_id`.execute(this.db);
    return rows.length > 0;
  }

  async seen(consumer: string, messageId: string) {
    const { rows } = await sql`
      SELECT 1 FROM inbox_message WHERE consumer = ${consumer} AND message_id = ${messageId}`.execute(
      this.db,
    );
    return rows.length > 0;
  }
}

export class PgTreasuryProgramRepository implements TreasuryProgramRepository {
  constructor(private readonly db: Queryable) {}

  async find(tenantId: string, programId: string) {
    const { rows } = await sql<ProgramRow>`
      SELECT * FROM program WHERE tenant_id = ${tenantId} AND id = ${programId}`.execute(this.db);
    return rows[0] === undefined ? null : toProgram(rows[0]);
  }

  async createIfMissing(program: { tenantId: string; id: string; currency: string }) {
    await sql`
      INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
      VALUES (${program.tenantId}, ${program.id}, ${program.currency}, 0)
      ON CONFLICT (tenant_id, id) DO NOTHING`.execute(this.db);
  }

  async applyChange(tenantId: string, programId: string, change: TreasuryChange) {
    const { rows } = await sql<ProgramRow>`
      UPDATE program
         SET credit_limit_minor = COALESCE(${change.creditLimitMinor?.toString() ?? null}::bigint, credit_limit_minor),
             status = COALESCE(${change.status ?? null}, status),
             reserved_minor = reserved_minor + ${text(change.reservedDeltaMinor ?? 0n)}::bigint,
             treasury_seq = GREATEST(treasury_seq, ${change.treasurySeq}),
             version = version + 1,
             platform_seq = platform_seq + 1,
             updated_at = now()
       WHERE tenant_id = ${tenantId} AND id = ${programId}
      RETURNING *`.execute(this.db);
    const row = rows[0];
    if (row === undefined) throw new Error('program vanished under its lock');
    return toProgram(row);
  }

  async markTreasurySeq(tenantId: string, programId: string, treasurySeq: number) {
    await sql`
      UPDATE program SET treasury_seq = GREATEST(treasury_seq, ${treasurySeq}), updated_at = now()
       WHERE tenant_id = ${tenantId} AND id = ${programId}`.execute(this.db);
  }
}

interface OwnReservationRow {
  id: string;
  invoice_id: string;
  invoice_currency: string;
  invoice_amount_minor: string;
  released_invoice_minor: string;
  amount_minor: string;
  released_minor: string;
  status: string;
  platform_seq: string;
  created_at: Date;
}

interface DiffRow {
  side: 'both' | 'snapshot-only' | 'ours-only';
  r_id: string | null;
  r_invoice_id: string | null;
  r_invoice_currency: string | null;
  r_invoice_amount_minor: string | null;
  r_released_invoice_minor: string | null;
  r_amount_minor: string | null;
  r_released_minor: string | null;
  r_status: string | null;
  r_platform_seq: string | null;
  r_created_at: Date | null;
  s_invoice_id: string | null;
  s_invoice_currency: string | null;
  s_outstanding_invoice_minor: string | null;
  s_outstanding_program_minor: string | null;
}

export class PgTreasuryReservationRepository implements TreasuryReservationRepository {
  constructor(private readonly db: Queryable) {}

  async listForProgram(tenantId: string, programId: string): Promise<OwnReservation[]> {
    const { rows } = await sql<OwnReservationRow>`
      SELECT id, invoice_id, invoice_currency, invoice_amount_minor, released_invoice_minor,
             amount_minor, released_minor, status, platform_seq, created_at
        FROM reservation WHERE tenant_id = ${tenantId} AND program_id = ${programId}`.execute(
      this.db,
    );
    return rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      invoiceCurrency: row.invoice_currency,
      invoiceAmountMinor: BigInt(row.invoice_amount_minor),
      releasedInvoiceMinor: BigInt(row.released_invoice_minor),
      amountMinor: BigInt(row.amount_minor),
      releasedMinor: BigInt(row.released_minor),
      status: row.status as OwnReservation['status'],
      platformSeq: Number(row.platform_seq),
      createdAt: row.created_at,
    }));
  }

  async loadSnapshot(stage: SnapshotStage, rows: readonly SnapshotRow[]) {
    if (rows.length === 0) return;
    await sql`
      INSERT INTO reconcile_snapshot_row (
        tenant_id, program_id, message_id, run_id, invoice_id, invoice_currency,
        outstanding_invoice_minor, outstanding_program_minor)
      SELECT * FROM unnest(
        ${rows.map(() => stage.tenantId)}::text[],
        ${rows.map(() => stage.programId)}::text[],
        ${rows.map(() => stage.messageId)}::text[],
        ${rows.map(() => stage.runId)}::text[],
        ${rows.map((row) => row.invoiceId)}::text[],
        ${rows.map((row) => row.invoiceCurrency)}::text[],
        ${rows.map((row) => text(row.outstandingInvoiceMinor))}::bigint[],
        ${rows.map((row) => text(row.outstandingProgramMinor))}::bigint[]
      )`.execute(this.db);
  }

  async clearSnapshot(stage: SnapshotStage) {
    await sql`
      DELETE FROM reconcile_snapshot_row
       WHERE tenant_id = ${stage.tenantId} AND program_id = ${stage.programId}
         AND message_id = ${stage.messageId} AND run_id = ${stage.runId}`.execute(this.db);
  }

  async diff(stage: SnapshotStage): Promise<ReconciliationDiffRow[]> {
    const { tenantId, programId } = stage;
    const { rows } = await sql<DiffRow>`
      WITH snapshot AS (
        SELECT invoice_id, invoice_currency, outstanding_invoice_minor, outstanding_program_minor
          FROM reconcile_snapshot_row
         WHERE tenant_id = ${tenantId} AND program_id = ${programId}
           AND message_id = ${stage.messageId} AND run_id = ${stage.runId}
      )
      SELECT 'both' AS side,
             r.id AS r_id, r.invoice_id AS r_invoice_id, r.invoice_currency AS r_invoice_currency,
             r.invoice_amount_minor AS r_invoice_amount_minor,
             r.released_invoice_minor AS r_released_invoice_minor,
             r.amount_minor AS r_amount_minor, r.released_minor AS r_released_minor,
             r.status AS r_status, r.platform_seq AS r_platform_seq, r.created_at AS r_created_at,
             s.invoice_id AS s_invoice_id, s.invoice_currency AS s_invoice_currency,
             s.outstanding_invoice_minor AS s_outstanding_invoice_minor,
             s.outstanding_program_minor AS s_outstanding_program_minor
        FROM snapshot s
        JOIN reservation r
          ON r.tenant_id = ${tenantId} AND r.program_id = ${programId} AND r.invoice_id = s.invoice_id
      UNION ALL
      SELECT 'snapshot-only', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             s.invoice_id, s.invoice_currency, s.outstanding_invoice_minor, s.outstanding_program_minor
        FROM snapshot s
       WHERE NOT EXISTS (
             SELECT 1 FROM reservation r
              WHERE r.tenant_id = ${tenantId} AND r.program_id = ${programId}
                AND r.invoice_id = s.invoice_id)
      UNION ALL
      SELECT 'ours-only', r.id, r.invoice_id, r.invoice_currency, r.invoice_amount_minor,
             r.released_invoice_minor, r.amount_minor, r.released_minor, r.status,
             r.platform_seq, r.created_at, NULL, NULL, NULL, NULL
        FROM reservation r
       WHERE r.tenant_id = ${tenantId} AND r.program_id = ${programId}
         AND r.status <> 'RELEASED'
         AND NOT EXISTS (
             SELECT 1 FROM reconcile_snapshot_row s
              WHERE s.tenant_id = ${tenantId} AND s.program_id = ${programId}
                AND s.message_id = ${stage.messageId} AND s.run_id = ${stage.runId}
                AND s.invoice_id = r.invoice_id)
    `.execute(this.db);
    return rows.map((row): ReconciliationDiffRow => ({
      side: row.side,
      reservation:
        row.r_id === null
          ? null
          : {
              id: row.r_id,
              invoiceId: row.r_invoice_id ?? '',
              invoiceCurrency: row.r_invoice_currency ?? '',
              invoiceAmountMinor: BigInt(row.r_invoice_amount_minor ?? 0),
              releasedInvoiceMinor: BigInt(row.r_released_invoice_minor ?? 0),
              amountMinor: BigInt(row.r_amount_minor ?? 0),
              releasedMinor: BigInt(row.r_released_minor ?? 0),
              status: (row.r_status ?? 'ACTIVE') as OwnReservation['status'],
              platformSeq: Number(row.r_platform_seq ?? 0),
              createdAt: row.r_created_at ?? new Date(0),
            },
      snapshot:
        row.s_invoice_id === null
          ? null
          : {
              invoiceId: row.s_invoice_id,
              invoiceCurrency: row.s_invoice_currency ?? '',
              outstandingInvoiceMinor: BigInt(row.s_outstanding_invoice_minor ?? 0),
              outstandingProgramMinor: BigInt(row.s_outstanding_program_minor ?? 0),
            },
    }));
  }

  async overwrite(tenantId: string, programId: string, rows: readonly ReservationOverwrite[]) {
    if (rows.length === 0) return;
    await sql`
      UPDATE reservation AS r
         SET invoice_amount_minor = v.invoice_amount_minor,
             amount_minor = v.amount_minor,
             released_invoice_minor = v.released_invoice_minor,
             released_minor = v.released_minor,
             status = v.status,
             updated_at = now()
        FROM unnest(
               ${rows.map((row) => row.id)}::uuid[],
               ${rows.map((row) => text(row.invoiceAmountMinor))}::bigint[],
               ${rows.map((row) => text(row.amountMinor))}::bigint[],
               ${rows.map((row) => text(row.releasedInvoiceMinor))}::bigint[],
               ${rows.map((row) => text(row.releasedMinor))}::bigint[],
               ${rows.map((row) => row.status)}::text[]
             ) AS v(id, invoice_amount_minor, amount_minor, released_invoice_minor, released_minor, status)
       WHERE r.id = v.id AND r.tenant_id = ${tenantId} AND r.program_id = ${programId}`.execute(
      this.db,
    );
  }

  async insertMany(rows: readonly Reservation[]) {
    if (rows.length === 0) return;
    await sql`
      INSERT INTO reservation (
        id, tenant_id, program_id, invoice_id, invoice_amount_minor, invoice_currency,
        fx_rate, fx_rate_source, fx_rate_at, amount_minor, status, origin, platform_seq,
        created_at, updated_at)
      SELECT * FROM unnest(
        ${rows.map((row) => row.id)}::uuid[],
        ${rows.map((row) => row.tenantId)}::text[],
        ${rows.map((row) => row.programId)}::text[],
        ${rows.map((row) => row.invoiceId)}::text[],
        ${rows.map((row) => text(row.invoiceAmount.minor))}::bigint[],
        ${rows.map((row) => row.invoiceAmount.currency)}::text[],
        ${rows.map((row) => formatFxRate(row.fx.rate))}::numeric[],
        ${rows.map((row) => row.fx.source)}::text[],
        ${rows.map((row) => row.fx.at.toISOString())}::timestamptz[],
        ${rows.map((row) => text(row.amountMinor))}::bigint[],
        ${rows.map((row) => row.status)}::text[],
        ${rows.map((row) => row.origin)}::text[],
        ${rows.map((row) => row.platformSeq)}::bigint[],
        ${rows.map((row) => row.createdAt.toISOString())}::timestamptz[],
        ${rows.map((row) => row.createdAt.toISOString())}::timestamptz[]
      )`.execute(this.db);
  }
}

export class PgFxRateWriter implements FxRateWriter {
  constructor(private readonly db: Queryable) {}

  async upsert(rate: { base: string; quote: string; rate: FxRate; source: string; asOf: Date }) {
    const { rows } = await sql`
      INSERT INTO fx_rate (base, quote, rate, source, as_of)
      VALUES (${rate.base}, ${rate.quote}, ${formatFxRate(rate.rate)}::numeric, ${rate.source},
              ${rate.asOf})
      ON CONFLICT (base, quote, as_of) DO NOTHING
      RETURNING base`.execute(this.db);
    return rows.length > 0;
  }
}

export class PgLedgerBatchWriter implements LedgerBatchWriter {
  constructor(private readonly db: Queryable) {}

  async appendMany(entries: readonly LedgerEntry[]) {
    if (entries.length === 0) return;
    await sql`
      INSERT INTO ledger_entry (
        tenant_id, program_id, reservation_id, kind, delta_reserved_minor, delta_limit_minor,
        limit_after, reserved_after, cause_type, cause_id, actor)
      SELECT * FROM unnest(
        ${entries.map((entry) => entry.tenantId)}::text[],
        ${entries.map((entry) => entry.programId)}::text[],
        ${entries.map((entry) => entry.reservationId)}::uuid[],
        ${entries.map((entry) => entry.kind)}::text[],
        ${entries.map((entry) => text(entry.deltaReservedMinor))}::bigint[],
        ${entries.map((entry) => text(entry.deltaLimitMinor))}::bigint[],
        ${entries.map((entry) => text(entry.limitAfter))}::bigint[],
        ${entries.map((entry) => text(entry.reservedAfter))}::bigint[],
        ${entries.map((entry) => entry.causeType)}::text[],
        ${entries.map((entry) => entry.causeId)}::text[],
        ${entries.map((entry) => entry.actor)}::text[]
      )`.execute(this.db);
  }
}
