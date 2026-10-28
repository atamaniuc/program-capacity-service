import { sql } from 'kysely';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION,
  InvariantCheckJob,
  RetentionCleanupJob,
} from '#src/capacity/adapters/in/jobs/jobs.js';
import { createPersistence, type Persistence } from '#src/capacity/adapters/out/postgres/db.js';
import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { PgMaintenanceStore } from '#src/capacity/adapters/out/postgres/repositories/maintenance.repository.js';
import { PostgresUnitOfWork } from '#src/capacity/adapters/out/postgres/unit-of-work.js';
import { systemClock, uuidV7Generator } from '#src/capacity/adapters/out/system/system.js';
import { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import { loadRuntimeSettings } from '#src/platform/telemetry/settings.js';
import { createOperationalMetrics } from '#src/platform/telemetry/metrics.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

interface LogLine {
  fields: Record<string, unknown>;
  message: string;
}

describe('scheduled jobs', () => {
  let postgres: TestPostgres;
  let persistence: Persistence;
  let store: PgMaintenanceStore;
  const errors: LogLine[] = [];
  const infos: LogLine[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => infos.push({ fields, message }),
    error: (fields: Record<string, unknown>, message: string) => errors.push({ fields, message }),
  };
  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    persistence = createPersistence(postgres.url, 5);
    store = new PgMaintenanceStore(persistence.db);
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
              VALUES ('bank-a', 'prg-ok', 'USD', 100000000), ('bank-a', 'prg-bad', 'USD', 100000000)`.execute(
      persistence.db,
    );
    // Real use cases, so reservations, releases and the ledger are written the production way.
    const uow = new PostgresUnitOfWork(persistence);
    const reserve = new ReserveCapacity({
      uow,
      clock: systemClock,
      ids: uuidV7Generator,
      fxMaxAgeMs: 60_000,
    });
    const release = new ReleaseReservation({ uow, clock: systemClock, ids: uuidV7Generator });
    for (const programId of ['prg-ok', 'prg-bad']) {
      for (const invoice of ['A', 'B', 'C']) {
        const outcome = await reserve.execute({
          tenantId: 'bank-a',
          actor: 'svc',
          requestId: `r-${programId}-${invoice}`,
          programId,
          invoiceId: `INV-${invoice}`,
          invoiceAmount: { minor: 100_000n, currency: 'USD' },
        });
        expect(outcome.ok).toBe(true);
        if (outcome.ok && invoice === 'A') {
          const released = await release.execute({
            tenantId: 'bank-a',
            actor: 'svc',
            requestId: `rel-${programId}`,
            programId,
            reservationId: outcome.value.reservationId,
            releaseRef: 'repay-1',
            amount: { minor: 40_000n, currency: 'USD' },
            reason: 'REPAID',
          });
          expect(released.ok).toBe(true);
        }
      }
    }
  });

  afterAll(async () => {
    await persistence.close();
    await postgres.stop();
  });

  it('FR-15 reports nothing while reserved agrees with the reservations and the ledger', async () => {
    const job = new InvariantCheckJob(store, logger, createOperationalMetrics(new Registry()));
    expect(await job.run()).toEqual([]);
    expect(errors).toHaveLength(0);
  });

  it('FR-15 reports a hand-corrupted reserved total in a metric and a log line', async () => {
    await sql`UPDATE program SET reserved_minor = reserved_minor + 12345 WHERE id = 'prg-bad'`.execute(
      persistence.db,
    );
    const metricsRegistry = new Registry();
    const reporting = new InvariantCheckJob(
      store,
      logger,
      createOperationalMetrics(metricsRegistry),
    );

    const mismatches = await reporting.run();
    expect(mismatches).toEqual([
      {
        tenantId: 'bank-a',
        programId: 'prg-bad',
        reservedMinor: 300_000n - 40_000n + 12_345n,
        reservationsMinor: 260_000n,
        ledgerMinor: 260_000n,
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({
      event: 'invariant-mismatch',
      programId: 'prg-bad',
      reservedMinor: '272345',
      reservationsMinor: '260000',
    });
    expect(await metricsRegistry.metrics()).toMatch(/^invariant_mismatch_programs 1$/m);
  });

  it('FR-15 also catches a ledger that disagrees with the program, and runs every 5 minutes by default', async () => {
    await sql`UPDATE program SET reserved_minor = 260000 WHERE id = 'prg-bad'`.execute(
      persistence.db,
    );
    await sql`UPDATE reservation SET released_minor = released_minor + 100,
                     released_invoice_minor = released_invoice_minor + 100
               WHERE program_id = 'prg-ok' AND invoice_id = 'INV-A'`.execute(persistence.db);
    const found = await new InvariantCheckJob(store, logger).run();
    expect(found.map((m) => m.programId)).toEqual(['prg-ok']);
    expect(found[0]).toMatchObject({ reservedMinor: 260_000n, reservationsMinor: 259_900n });
    expect(loadRuntimeSettings({}).invariantCheckIntervalMs).toBe(5 * 60_000);
  });

  it('NFR-11 retention removes idempotency keys older than 24 h and inbox and published outbox rows older than 7 days', async () => {
    const db = persistence.db;
    await sql`INSERT INTO idempotency_key (tenant_id, key, fingerprint, status_code, response_body, created_at)
              VALUES ('bank-a', 'old', 'f', 200, '{}', now() - interval '25 hours'),
                     ('bank-a', 'fresh', 'f', 200, '{}', now() - interval '23 hours')`.execute(db);
    await sql`INSERT INTO inbox_message (consumer, message_id, topic, "partition", "offset", processed_at)
              VALUES ('c', 'old', 't', 0, 1, now() - interval '8 days'),
                     ('c', 'fresh', 't', 0, 2, now() - interval '6 days')`.execute(db);
    await sql`INSERT INTO outbox_event (tenant_id, program_id, program_seq, type, payload, created_at, published_at)
              VALUES ('bank-a', 'x', 1, 'T', '{}', now() - interval '9 days', now() - interval '8 days'),
                     ('bank-a', 'x', 2, 'T', '{}', now() - interval '9 days', now() - interval '6 days'),
                     ('bank-a', 'x', 3, 'T', '{}', now() - interval '9 days', NULL)`.execute(db);

    const result = await new RetentionCleanupJob(store, logger, DEFAULT_RETENTION).run();
    expect(result).toMatchObject({ idempotencyKeys: 1, inboxMessages: 1, outboxEvents: 1 });

    const left = await sql<{ what: string }>`
      SELECT 'key:' || key AS what FROM idempotency_key
      UNION ALL SELECT 'inbox:' || message_id FROM inbox_message
      UNION ALL SELECT 'outbox:' || program_seq FROM outbox_event WHERE program_id = 'x'
      ORDER BY 1`.execute(db);
    expect(left.rows.map((row) => row.what)).toEqual([
      'inbox:fresh',
      'key:fresh',
      'outbox:2',
      'outbox:3',
    ]);
    expect(infos.some((line) => line.fields['event'] === 'retention-cleanup')).toBe(true);
  });
});
