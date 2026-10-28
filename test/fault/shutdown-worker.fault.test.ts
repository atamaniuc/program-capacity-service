import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
} from '#src/capacity/application/shared/treasury-messages.js';
import { closeWithin } from '#src/platform/bootstrap/shutdown.js';
import { createLogger } from '#src/platform/logging/logger.js';
import { startKafka, type TestKafka } from '../kafka/support/kafka.js';
import { limitSet } from '../../tools/simulator/messages.js';
import { connectProducer, type SimulatorProducer } from '../../tools/simulator/producer.js';
import { startFaultApp, waitFor, type FaultApp } from '../support/fault-app.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

describe('shutdown worker', () => {
  let postgres: TestPostgres;
  let kafka: TestKafka;
  let service: FaultApp;
  let producer: SimulatorProducer;
  let locker: pg.Client;
  let observer: pg.Client;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([startPostgres(), startKafka()]);
    await kafka.createTopics([
      TOPIC_CAPACITY,
      TOPIC_FX_RATES,
      `${TOPIC_CAPACITY}.dlq`,
      `${TOPIC_FX_RATES}.dlq`,
    ]);
    service = await startFaultApp({
      databaseUrl: postgres.url,
      role: 'worker',
      kafkaBrokers: kafka.brokers,
      env: { OUTBOX_RELAY_ENABLED: 'false' },
    });
    producer = await connectProducer([kafka.brokers]);
    locker = new pg.Client({ connectionString: postgres.url, application_name: 'locker' });
    observer = new pg.Client({ connectionString: postgres.url, application_name: 'observer' });
    await locker.connect();
    await observer.connect();
    await observer.query(`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
                          VALUES ('bank-a', 'prg-drain', 'USD', 1000000000)`);
  });

  afterAll(async () => {
    await producer.close();
    await locker.end();
    await observer.end();
    await service.stopIssuer();
    await Promise.all([kafka.stop(), postgres.stop()]);
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

  const committedOffset = async (): Promise<number> => {
    const client = new KafkaJS.Kafka({
      kafkaJS: { brokers: [kafka.brokers], logLevel: KafkaJS.logLevel.ERROR },
    });
    const admin = client.admin();
    await admin.connect();
    try {
      const groups = (await admin.fetchOffsets({
        groupId: 'program-capacity-treasury',
        topics: [TOPIC_CAPACITY],
      })) as { partitions: { partition: number; offset: string }[] }[];
      return Number(
        groups.flatMap((group) => group.partitions).find((p) => p.partition === 0)?.offset ?? -1,
      );
    } finally {
      await admin.disconnect();
    }
  };

  it('NFR-07 on SIGTERM the treasury consumer drains its in-flight message, commits its offset and closes within 25 s', async () => {
    await locker.query(
      "BEGIN; SELECT 1 FROM program WHERE tenant_id = 'bank-a' AND id = 'prg-drain' FOR UPDATE",
    );
    await producer.send([
      limitSet(
        { tenantId: 'bank-a', programId: 'prg-drain', seq: 1 },
        { value: '5000000.00', currency: 'USD' },
      ),
    ]);
    await waitFor('the treasury consumer to wait for the program lock', async () => {
      const waiting = await observer.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      return Number(waiting.rows[0]?.count) > 0;
    });

    const started = Date.now();
    const closing = closeWithin(service.app, createLogger('silent'));
    await waitFor('readiness to turn false', async () => (await service.ready()).status === 503);
    await locker.query('COMMIT');
    await closing;

    expect(Date.now() - started).toBeLessThan(25_000);
    expect(await committedOffset()).toBe(1);
    expect(await serviceConnections()).toBe(0);
  });
});
