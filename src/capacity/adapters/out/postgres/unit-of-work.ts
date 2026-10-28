import { sql } from 'kysely';
import type { TransactionScope, UnitOfWork } from '#src/capacity/application/ports/index.js';
import type { Persistence } from './db.js';
import { PgFxRateReader } from './repositories/fx-rate.repository.js';
import { PgIdempotencyStore } from './repositories/idempotency.repository.js';
import { PgLedgerWriter, PgOutboxWriter } from './repositories/ledger-outbox.repository.js';
import { PgProgramRepository } from './repositories/program.repository.js';
import { PgReleaseRepository } from './repositories/release.repository.js';
import { PgReservationRepository } from './repositories/reservation.repository.js';
import type { Queryable } from './repositories/rows.js';

export interface TransactionTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

const DEFAULT_TIMEOUTS: TransactionTimeouts = { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000 };

export function createScope(db: Queryable): TransactionScope {
  return {
    programs: new PgProgramRepository(db),
    reservations: new PgReservationRepository(db),
    releases: new PgReleaseRepository(db),
    ledger: new PgLedgerWriter(db),
    outbox: new PgOutboxWriter(db),
    fxRates: new PgFxRateReader(db),
    idempotency: new PgIdempotencyStore(db),
  };
}

/**
 * One READ COMMITTED transaction per use case. Timeouts are set with `set_config(…, true)`, i.e.
 * `SET LOCAL`, so no session state survives the transaction (NFR-15).
 */
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(
    private readonly persistence: Pick<Persistence, 'db'>,
    private readonly timeouts: TransactionTimeouts = DEFAULT_TIMEOUTS,
  ) {}

  run<T>(work: (tx: TransactionScope) => Promise<T>): Promise<T> {
    return this.persistence.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await sql`
          SELECT set_config('lock_timeout', ${`${this.timeouts.lockTimeoutMs}ms`}, true),
                 set_config('statement_timeout', ${`${this.timeouts.statementTimeoutMs}ms`}, true)`.execute(
          trx,
        );
        return work(createScope(trx));
      });
  }
}
