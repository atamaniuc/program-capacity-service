import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFixedPostgres,
  startKafkaBroker,
  type FixedPostgres,
  type KafkaBroker,
} from '../support/outage-containers.js';
import { startFaultApp, waitFor, type FaultApp } from '../support/fault-app.js';

async function scalar(url: string, query: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ value: string }>(query);
    return result.rows[0]?.value ?? '';
  } finally {
    await client.end();
  }
}

describe('outages', () => {
  let postgres: FixedPostgres;
  let kafka: KafkaBroker;
  let service: FaultApp;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([startFixedPostgres(), startKafkaBroker()]);
    service = await startFaultApp({
      databaseUrl: postgres.url,
      role: 'all',
      kafkaBrokers: kafka.brokers,
    });
    const client = new pg.Client({ connectionString: postgres.url });
    await client.connect();
    await client.query(`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
                        VALUES ('bank-a', 'prg-outage', 'USD', 1000000000)`);
    await client.end();
  });

  afterAll(async () => {
    await service.app.close();
    await service.stopIssuer();
    await Promise.all([postgres.remove(), kafka.remove()]);
  });

  const reserve = (invoiceId: string) =>
    service.post('/v1/programs/prg-outage/reservations', {
      invoiceId,
      amount: { value: '100.00', currency: 'USD' },
    });
  const unpublished = (): Promise<string> =>
    scalar(postgres.url, 'SELECT count(*) AS value FROM outbox_event WHERE published_at IS NULL');

  it('NFR-06 the API answers while Kafka is down and the outbox drains on recovery', async () => {
    await kafka.stop();

    for (const invoice of ['INV-K1', 'INV-K2', 'INV-K3']) {
      const created = await reserve(invoice);
      expect(created.status).toBe(201);
    }
    expect((await service.get('/v1/programs/prg-outage/capacity')).status).toBe(200);
    expect((await service.ready()).status).toBe(200);

    // The relay cannot reach Kafka: the rows wait in the outbox and the lag metric shows it.
    await waitFor('outbox lag metric', async () => {
      const metrics = await (await fetch(`${service.opsUrl}/metrics`)).text();
      return /^outbox_lag 3$/m.test(metrics);
    });
    expect(await unpublished()).toBe('3');

    await kafka.start();
    await waitFor('outbox drained', async () => (await unpublished()) === '0', 90_000);
    const delivered = await kafka.readTopic('capacity.events.v1', 3);
    expect(delivered.map((message) => message.value['type'])).toEqual([
      'ReservationCreated',
      'ReservationCreated',
      'ReservationCreated',
    ]);
    expect(delivered.every((message) => message.key === 'bank-a:prg-outage')).toBe(true);
  });

  it('NFR-06 with PostgreSQL stopped readiness is false and the API returns 503, then recovers', async () => {
    await postgres.stop();

    const ready = await service.ready();
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: 'down', db: 'down' });

    const response = await service.get('/v1/programs/prg-outage/capacity');
    expect(response.status).toBe(503);
    expect((response.body as { type: string }).type).toContain('service-unavailable');

    await postgres.start();
    await waitFor('readiness after restart', async () => (await service.ready()).status === 200);
    expect((await service.get('/v1/programs/prg-outage/capacity')).status).toBe(200);
  });
});
