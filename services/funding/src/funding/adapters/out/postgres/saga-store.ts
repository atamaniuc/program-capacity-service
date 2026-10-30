import { sql, type Transaction } from 'kysely';
import type {
  Claim,
  SagaStats,
  SagaStatsSource,
  SagaStore,
} from '../../../application/saga-ports.js';
import {
  formatMoney,
  type FundingRequest,
  type FundingState,
  type Transition,
} from '../../../domain/index.js';
import type { Database, Persistence } from './db.js';
import { latestMigration } from './migrate.js';
import type { TransactionTimeouts } from './unit-of-work.js';

const DEFAULT_TIMEOUTS: TransactionTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000 };

/** Instants leave the database as epoch milliseconds: the domain never sees a `Date`. */
const MS = (column: string) => sql.raw(`(extract(epoch from ${column}) * 1000)::bigint::text`);

interface Row {
  id: string;
  tenant_id: string;
  program_id: string;
  invoice_id: string;
  currency: string;
  amount_minor: string;
  state: string;
  reason: string | null;
  reservation_id: string | null;
  payment_id: string | null;
  attempts: number;
  version: string;
  next_attempt_ms: string;
  reserve_deadline_ms: string | null;
  disburse_deadline_ms: string | null;
  resolution_deadline_ms: string | null;
  created_ms: string;
  now_ms: string;
}

function toRequest(row: Row): FundingRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    programId: row.program_id,
    invoiceId: row.invoice_id,
    amount: { minor: BigInt(row.amount_minor), currency: row.currency },
    state: row.state as FundingState,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.reservation_id === null ? {} : { reservationId: row.reservation_id }),
    ...(row.payment_id === null ? {} : { paymentId: row.payment_id }),
    attempts: row.attempts,
    nextAttemptAt: Number(row.next_attempt_ms),
    ...(row.reserve_deadline_ms === null
      ? {}
      : { reserveDeadlineAt: Number(row.reserve_deadline_ms) }),
    ...(row.disburse_deadline_ms === null
      ? {}
      : { disburseDeadlineAt: Number(row.disburse_deadline_ms) }),
    ...(row.resolution_deadline_ms === null
      ? {}
      : { resolutionDeadlineAt: Number(row.resolution_deadline_ms) }),
    createdAt: Number(row.created_ms),
  };
}

const instant = (ms: number | undefined) =>
  ms === undefined ? sql`NULL::timestamptz` : sql`to_timestamp(${ms}::double precision / 1000)`;

/** The driver's side of the funding database (ADR 025): claim, version-checked record. */
export class PostgresSagaStore implements SagaStore, SagaStatsSource {
  constructor(
    private readonly persistence: Persistence,
    private readonly timeouts: TransactionTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  private transaction<T>(work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.persistence.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('lock_timeout', ${`${this.timeouts.lockTimeoutMs.toString()}ms`}, true),
                       set_config('statement_timeout', ${`${this.timeouts.statementTimeoutMs.toString()}ms`}, true)`.execute(
        trx,
      );
      return work(trx);
    });
  }

  async ping(): Promise<void> {
    const latest = await latestMigration();
    const { rows } = await sql<{ migrated: boolean }>`
      SELECT to_regclass('public.schema_migrations') IS NOT NULL
         AND EXISTS (SELECT 1 FROM schema_migrations WHERE filename = ${latest}) AS migrated`.execute(
      this.persistence.db,
    );
    if (rows[0]?.migrated !== true) throw new Error('schema is not migrated');
  }

  async stats(): Promise<SagaStats> {
    const { rows } = await sql<{ state: string; n: string; age: string; unresolved_age: string }>`
      SELECT state,
             count(*)::text AS n,
             coalesce(extract(epoch from now() - min(created_at)), 0)::float8::text AS age,
             coalesce(extract(epoch from now() - min(updated_at)
               FILTER (WHERE state = 'COMPENSATING' AND reservation_id IS NULL)), 0)::float8::text
               AS unresolved_age
        FROM funding_request
       GROUP BY state`.execute(this.persistence.db);
    const counts = new Map<string, number>();
    const oldest = new Map<string, number>();
    let unresolved = 0;
    for (const row of rows) {
      counts.set(row.state, Number(row.n));
      if (['RECEIVED', 'RESERVING', 'DISBURSING', 'COMPENSATING'].includes(row.state)) {
        oldest.set(row.state, Number(row.age));
      }
      unresolved = Math.max(unresolved, Number(row.unresolved_age));
    }
    return { counts, oldestAgeSeconds: oldest, oldestUnresolvedReserveAgeSeconds: unresolved };
  }

  async now(): Promise<number> {
    const { rows } = await sql<{ ms: string }>`
      SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint::text AS ms`.execute(
      this.persistence.db,
    );
    return Number(rows[0]?.ms);
  }

  async claimDue(owner: string, leaseMs: number, limit: number): Promise<readonly Claim[]> {
    return this.transaction(async (trx) => {
      const { rows } = await sql<Row>`
        WITH due AS (
          SELECT id FROM funding_request
          WHERE state IN ('RECEIVED', 'RESERVING', 'DISBURSING', 'COMPENSATING')
            AND next_attempt_at <= now()
            AND (lease_until IS NULL OR lease_until <= now())
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
        UPDATE funding_request r
           SET lease_owner = ${owner},
               lease_until = now() + (${leaseMs}::double precision * interval '1 millisecond'),
               version = r.version + 1,
               updated_at = now()
          FROM due
         WHERE r.id = due.id
        RETURNING r.id, r.tenant_id, r.program_id, r.invoice_id, r.currency,
                  r.amount_minor::text AS amount_minor, r.state, r.reason, r.reservation_id,
                  r.payment_id, r.attempts, r.version::text AS version,
                  ${MS('r.next_attempt_at')} AS next_attempt_ms,
                  ${MS('r.reserve_deadline_at')} AS reserve_deadline_ms,
                  ${MS('r.disburse_deadline_at')} AS disburse_deadline_ms,
                  ${MS('r.resolution_deadline_at')} AS resolution_deadline_ms,
                  ${MS('r.created_at')} AS created_ms,
                  (extract(epoch from now()) * 1000)::bigint::text AS now_ms`.execute(trx);
      return rows.map((row) => ({
        request: toRequest(row),
        version: BigInt(row.version),
        leaseOwner: owner,
        claimedAt: Number(row.now_ms),
      }));
    });
  }

  async record(claim: Claim, transition: Transition): Promise<boolean> {
    const next = transition.request;
    return this.transaction(async (trx) => {
      const updated = await sql<{ id: string }>`
        UPDATE funding_request
           SET state = ${next.state},
               reason = ${next.reason ?? null},
               reservation_id = ${next.reservationId ?? null},
               payment_id = ${next.paymentId ?? null},
               attempts = ${next.attempts},
               next_attempt_at = ${instant(next.nextAttemptAt)},
               reserve_deadline_at = ${instant(next.reserveDeadlineAt)},
               disburse_deadline_at = ${instant(next.disburseDeadlineAt)},
               resolution_deadline_at = ${instant(next.resolutionDeadlineAt)},
               lease_owner = NULL,
               lease_until = NULL,
               version = version + 1,
               updated_at = now()
         WHERE id = ${claim.request.id} AND version = ${claim.version.toString()}::bigint
        RETURNING id`.execute(trx);
      if (updated.rows.length === 0) return false;
      const attempt = transition.attempt;
      await sql`
        INSERT INTO saga_step_attempt
          (request_id, step, step_key, outcome_class, state_before, state_after, detail)
        VALUES (${claim.request.id}, ${attempt.step}, ${attempt.key ?? null}, ${attempt.class},
                ${claim.request.state}, ${next.state},
                ${JSON.stringify({ attempts: next.attempts, reason: next.reason ?? null })}::jsonb)`.execute(
        trx,
      );
      if (transition.event !== undefined) {
        await sql`
          INSERT INTO outbox_event (tenant_id, request_id, type, payload)
          VALUES (${next.tenantId}, ${next.id}, ${transition.event},
                  ${JSON.stringify({
                    fundingRequestId: next.id,
                    programId: next.programId,
                    invoiceId: next.invoiceId,
                    amount: {
                      value: formatMoney(next.amount),
                      currency: next.amount.currency,
                    },
                    state: next.state,
                    reason: next.reason ?? null,
                    reservationId: next.reservationId ?? null,
                    paymentId: next.paymentId ?? null,
                  })}::jsonb)`.execute(trx);
      }
      return true;
    });
  }
}
