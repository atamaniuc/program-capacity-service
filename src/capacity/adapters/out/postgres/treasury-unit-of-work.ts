import { sql } from 'kysely';
import type { TreasuryScope, TreasuryUnitOfWork } from '#src/capacity/application/ports/index.js';
import type { Persistence } from './db.js';
import {
  PgFxRateWriter,
  PgInboxStore,
  PgLedgerBatchWriter,
  PgTreasuryProgramRepository,
  PgTreasuryReservationRepository,
} from './repositories/treasury.repository.js';
import type { Queryable } from './repositories/rows.js';
import { createScope, type TransactionTimeouts } from './unit-of-work.js';

const DEFAULT_TIMEOUTS: TransactionTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 30_000 };

export function createTreasuryScope(db: Queryable): TreasuryScope {
  return {
    ...createScope(db),
    inbox: new PgInboxStore(db),
    treasuryPrograms: new PgTreasuryProgramRepository(db),
    treasuryReservations: new PgTreasuryReservationRepository(db),
    fxWriter: new PgFxRateWriter(db),
    ledgerBatch: new PgLedgerBatchWriter(db),
  };
}

/** The consumer's unit of work: one READ COMMITTED transaction per message, like the API's. */
export class PostgresTreasuryUnitOfWork implements TreasuryUnitOfWork {
  constructor(
    private readonly persistence: Pick<Persistence, 'db'>,
    private readonly timeouts: TransactionTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  run<T>(work: (tx: TreasuryScope) => Promise<T>): Promise<T> {
    return this.persistence.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await sql`
          SELECT set_config('lock_timeout', ${`${this.timeouts.lockTimeoutMs}ms`}, true),
                 set_config('statement_timeout', ${`${this.timeouts.statementTimeoutMs}ms`}, true)`.execute(
          trx,
        );
        return work(createTreasuryScope(trx));
      });
  }
}
