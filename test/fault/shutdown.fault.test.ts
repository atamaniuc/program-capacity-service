import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeWithin } from '#src/platform/bootstrap/shutdown.js';
import { createLogger } from '#src/platform/logging/logger.js';
import { startFaultApp, waitFor, type FaultApp } from '../support/fault-app.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

describe('shutdown', () => {
  let postgres: TestPostgres;
  let service: FaultApp;
  let locker: pg.Client;
  let observer: pg.Client;

  beforeAll(async () => {
    postgres = await startPostgres();
    service = await startFaultApp({ databaseUrl: postgres.url, role: 'api' });
    locker = new pg.Client({ connectionString: postgres.url, application_name: 'locker' });
    observer = new pg.Client({ connectionString: postgres.url, application_name: 'observer' });
    await locker.connect();
    await observer.connect();
    await observer.query(`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
                          VALUES ('bank-a', 'prg-drain', 'USD', 1000000000)`);
  });

  afterAll(async () => {
    await locker.end();
    await observer.end();
    await service.stopIssuer();
    await postgres.stop();
  });

  /** Connections the service itself holds: neither of the two test clients. */
  const serviceConnections = async (): Promise<number> => {
    const result = await observer.query<{ count: string }>(
      `SELECT count(*) FROM pg_stat_activity
        WHERE datname = 'capacity' AND backend_type = 'client backend'
          AND application_name NOT IN ('locker', 'observer')`,
    );
    return Number(result.rows[0]?.count);
  };

  it('NFR-07 on shutdown readiness turns false, the in-flight request completes and the pool closes within 25 s', async () => {
    // Warm the pool, then hold the program row so the next reserve is genuinely in flight.
    expect((await service.get('/v1/programs/prg-drain/capacity')).status).toBe(200);
    expect(await serviceConnections()).toBeGreaterThan(0);
    await locker.query("BEGIN; SELECT 1 FROM program WHERE id = 'prg-drain' FOR UPDATE");

    const inFlight = service.post('/v1/programs/prg-drain/reservations', {
      invoiceId: 'INV-DRAIN',
      amount: { value: '250.00', currency: 'USD' },
    });
    await waitFor('the reserve to wait for the program lock', async () => {
      const waiting = await observer.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      return Number(waiting.rows[0]?.count) > 0;
    });

    const started = Date.now();
    const closing = closeWithin(service.app, createLogger('silent'));
    await waitFor('readiness to turn false', async () => (await service.ready()).status === 503);

    // Intake is closed and the request still holds its connection; releasing the lock lets it finish.
    await locker.query('COMMIT');
    const answer = await inFlight;
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ invoiceId: 'INV-DRAIN', status: 'ACTIVE' });

    await closing;
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(await serviceConnections()).toBe(0);
    await expect(fetch(`${service.baseUrl}/v1/programs/prg-drain/capacity`)).rejects.toThrow();
  });

  it('NFR-07 closing twice is harmless', async () => {
    await expect(service.app.close()).resolves.toBeUndefined();
  });
});
