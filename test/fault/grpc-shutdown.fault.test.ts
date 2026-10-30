import { status } from '@grpc/grpc-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReserveResult } from '@finverity/contracts/capacity/v1';
import { closeWithin } from '#src/platform/bootstrap/shutdown.js';
import { createLogger } from '#src/platform/logging/logger.js';
import { startFaultApp, waitFor, type FaultApp } from '../support/fault-app.js';
import { grpcTestClient, type GrpcTestClient } from '../support/grpc-client.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

describe('gRPC shutdown', () => {
  let postgres: TestPostgres;
  let service: FaultApp;
  let client: GrpcTestClient;
  let locker: pg.Client;
  let observer: pg.Client;

  beforeAll(async () => {
    postgres = await startPostgres();
    service = await startFaultApp({ databaseUrl: postgres.url, role: 'api' });
    client = grpcTestClient(service.grpcTarget);
    locker = new pg.Client({ connectionString: postgres.url, application_name: 'locker' });
    observer = new pg.Client({ connectionString: postgres.url, application_name: 'observer' });
    await locker.connect();
    await observer.connect();
    await observer.query(`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
                          VALUES ('bank-a', 'prg-grpc-drain', 'USD', 1000000000)`);
  });

  afterAll(async () => {
    client.close();
    await locker.end();
    await observer.end();
    await service.stopIssuer();
    await postgres.stop();
  });

  const serviceConnections = async (): Promise<number> => {
    const result = await observer.query<{ count: string }>(
      `SELECT count(*) FROM pg_stat_activity
        WHERE datname = 'capacity' AND backend_type = 'client backend'
          AND application_name NOT IN ('locker', 'observer')`,
    );
    return Number(result.rows[0]?.count);
  };

  const reserve = {
    programId: 'prg-grpc-drain',
    invoiceId: 'INV-GRPC-DRAIN',
    amount: { value: '250.00', currencyCode: 'USD' },
  };

  it('GR-07 on SIGTERM new calls are refused, the in-flight call finishes and the process closes within 25 s', async () => {
    const token = await service.token();
    expect((await client.getAvailability({ programId: 'prg-grpc-drain' }, { token })).ok).toBe(
      true,
    );
    expect(await serviceConnections()).toBeGreaterThan(0);
    await locker.query("BEGIN; SELECT 1 FROM program WHERE id = 'prg-grpc-drain' FOR UPDATE");

    const inFlight = client.reserve(reserve, { token, idempotencyKey: 'gr07-drain' });
    await waitFor('the reserve to wait for the program lock', async () => {
      const waiting = await observer.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      return Number(waiting.rows[0]?.count) > 0;
    });

    const started = Date.now();
    const closing = closeWithin(service.app, createLogger('silent'));
    await waitFor('readiness to turn false', async () => (await service.ready()).status === 503);

    // A new call, on a new connection, is refused while the old one is still in flight.
    const fresh = grpcTestClient(service.grpcTarget);
    const refused = await fresh.getAvailability(
      { programId: 'prg-grpc-drain' },
      { token, deadlineMs: 3000 },
    );
    expect(refused).toMatchObject({ ok: false, code: status.UNAVAILABLE });
    fresh.close();

    await locker.query('COMMIT');
    const answer = await inFlight;
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.value.result).toBe(ReserveResult.RESERVE_RESULT_CREATED);
      expect(answer.value.reservation?.invoiceId).toBe('INV-GRPC-DRAIN');
    }

    await closing;
    expect(Date.now() - started).toBeLessThan(25_000);
    await waitFor(
      'the service backends to leave pg_stat_activity',
      async () => (await serviceConnections()) === 0,
      5_000,
    );
  });
});
