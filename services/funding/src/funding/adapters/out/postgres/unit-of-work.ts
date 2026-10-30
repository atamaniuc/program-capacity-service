import { sql, type Transaction } from 'kysely';
import type { FundingState } from '../../../domain/index.js';
import type { Outcome } from '../../../application/problem.js';
import type {
  FundingRequestRecord,
  FundingTransaction,
  UnitOfWork,
} from '../../../application/ports.js';
import type { Selectable } from 'kysely';
import type { Database, FundingRequestTable, Persistence } from './db.js';

const COLUMNS = [
  'id',
  'tenant_id',
  'program_id',
  'invoice_id',
  'currency',
  'amount_minor',
  'state',
  'reason',
  'reservation_id',
  'payment_id',
  'created_at',
] as const;

function toRecord(row: Selectable<FundingRequestTable>): FundingRequestRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    programId: row.program_id,
    invoiceId: row.invoice_id,
    currency: row.currency,
    amountMinor: BigInt(row.amount_minor),
    state: row.state as FundingState,
    reason: row.reason,
    reservationId: row.reservation_id,
    paymentId: row.payment_id,
    createdAt: row.created_at,
  };
}

export interface TransactionTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: TransactionTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000 };

class PgFundingTransaction implements FundingTransaction {
  constructor(private readonly trx: Transaction<Database>) {}

  async claimKey(tenantId: string, key: string, fingerprint: string): Promise<boolean> {
    const result = await this.trx
      .insertInto('idempotency_key')
      .values({ tenant_id: tenantId, key, fingerprint, status_code: null, response_body: null })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();
    return result !== undefined;
  }

  async findKey(tenantId: string, key: string) {
    const row = await this.trx
      .selectFrom('idempotency_key')
      .select(['fingerprint', 'status_code', 'response_body'])
      .where('tenant_id', '=', tenantId)
      .where('key', '=', key)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      fingerprint: row.fingerprint,
      outcome: row.status_code === null ? null : (row.response_body as Outcome<unknown>),
    };
  }

  async completeKey(
    tenantId: string,
    key: string,
    status: number,
    outcome: Outcome<unknown>,
  ): Promise<void> {
    await this.trx
      .updateTable('idempotency_key')
      .set({ status_code: status, response_body: JSON.stringify(outcome) })
      .where('tenant_id', '=', tenantId)
      .where('key', '=', key)
      .execute();
  }

  async insertRequest(row: {
    tenantId: string;
    programId: string;
    invoiceId: string;
    currency: string;
    amountMinor: bigint;
  }) {
    const inserted = await this.trx
      .insertInto('funding_request')
      .values({
        tenant_id: row.tenantId,
        program_id: row.programId,
        invoice_id: row.invoiceId,
        currency: row.currency,
        amount_minor: row.amountMinor.toString(),
        state: 'RECEIVED',
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'program_id', 'invoice_id']).doNothing())
      .returning(COLUMNS)
      .executeTakeFirst();
    if (inserted !== undefined) return { record: toRecord(inserted), created: true };
    const existing = await this.trx
      .selectFrom('funding_request')
      .select(COLUMNS)
      .where('tenant_id', '=', row.tenantId)
      .where('program_id', '=', row.programId)
      .where('invoice_id', '=', row.invoiceId)
      .executeTakeFirstOrThrow();
    return { record: toRecord(existing), created: false };
  }

  async insertOutbox(
    tenantId: string,
    requestId: string,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.trx
      .insertInto('outbox_event')
      .values({
        tenant_id: tenantId,
        request_id: requestId,
        type,
        payload: JSON.stringify(payload),
      })
      .execute();
  }

  async findRequest(tenantId: string, id: string): Promise<FundingRequestRecord | null> {
    const row = await this.trx
      .selectFrom('funding_request')
      .select(COLUMNS)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }
}

/** One transaction per use case, with `lock_timeout` and `statement_timeout` (ADR 003). */
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(
    private readonly persistence: Persistence,
    private readonly timeouts: TransactionTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  run<T>(work: (tx: FundingTransaction) => Promise<T>): Promise<T> {
    return this.persistence.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('lock_timeout', ${`${this.timeouts.lockTimeoutMs.toString()}ms`}, true),
                       set_config('statement_timeout', ${`${this.timeouts.statementTimeoutMs.toString()}ms`}, true)`.execute(
        trx,
      );
      return work(new PgFundingTransaction(trx));
    });
  }
}
