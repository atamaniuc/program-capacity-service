import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { CAPACITY_EVENTS_TOPIC } from '#src/capacity/adapters/out/kafka/event-publisher.js';
import {
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
} from '#src/capacity/application/shared/treasury-messages.js';
import { startKafka, type TestKafka } from './support/kafka.js';
import { limitSet } from '../../tools/simulator/messages.js';
import { connectProducer, type SimulatorProducer } from '../../tools/simulator/producer.js';
import { startFaultApp, waitFor, type FaultApp } from '../support/fault-app.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

describe('worker role wiring (MAJOR-1 regression)', () => {
  let postgres: TestPostgres;
  let kafka: TestKafka;
  let service: FaultApp;
  let producer: SimulatorProducer;
  let observer: pg.Client;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([startPostgres(), startKafka()]);
    await kafka.createTopics([
      TOPIC_CAPACITY,
      TOPIC_FX_RATES,
      CAPACITY_EVENTS_TOPIC,
      `${TOPIC_CAPACITY}.dlq`,
      `${TOPIC_FX_RATES}.dlq`,
    ]);
    service = await startFaultApp({
      databaseUrl: postgres.url,
      role: 'all',
      kafkaBrokers: kafka.brokers,
      env: { OUTBOX_RELAY_ENABLED: 'true', OUTBOX_POLL_INTERVAL_MS: '200' },
    });
    producer = await connectProducer([kafka.brokers]);
    observer = new pg.Client({ connectionString: postgres.url, application_name: 'observer' });
    await observer.connect();
  });

  afterAll(async () => {
    await producer.close();
    await observer.end();
    await service.stopIssuer();
    await Promise.all([kafka.stop(), postgres.stop()]);
  });

  const readEvents = async (count: number, timeoutMs = 30_000) => {
    const client = new KafkaJS.Kafka({
      kafkaJS: { brokers: [kafka.brokers], logLevel: KafkaJS.logLevel.ERROR },
    });
    const consumer = client.consumer({
      kafkaJS: {
        groupId: `read-events-${Math.random().toString(36).slice(2)}`,
        fromBeginning: true,
      },
    });
    const seen: { key: Buffer | null; value: Buffer | null; headers: KafkaJS.IHeaders }[] = [];
    await consumer.connect();
    await consumer.subscribe({ topic: CAPACITY_EVENTS_TOPIC });
    await consumer.run({
      eachMessage: ({ message }) => {
        seen.push({ key: message.key, value: message.value, headers: message.headers ?? {} });
        return Promise.resolve();
      },
    });
    try {
      await waitFor(
        `${count} event(s) on ${CAPACITY_EVENTS_TOPIC}`,
        () => Promise.resolve(seen.length >= count),
        timeoutMs,
      );
    } finally {
      await consumer.disconnect();
    }
    return seen;
  };

  it('MAJOR-1 the all role ingests a treasury message and the relay publishes its outbox event', async () => {
    await producer.send([
      limitSet(
        { tenantId: 'bank-a', programId: 'prg-relay', seq: 1 },
        { value: '2500000.00', currency: 'USD' },
      ),
    ]);
    await waitFor('the treasury consumer to apply the limit', async () => {
      const { rows } = await observer.query<{ credit_limit_minor: string }>(
        `SELECT credit_limit_minor FROM program WHERE tenant_id = 'bank-a' AND id = 'prg-relay'`,
      );
      return rows[0]?.credit_limit_minor === '250000000' ? true : false;
    });

    const events = await readEvents(1);
    expect(events).toHaveLength(1);
    const value = JSON.parse(String(events[0]?.value)) as Record<string, unknown>;
    expect(value).toMatchObject({
      type: 'ProgramCapacityChanged',
      tenantId: 'bank-a',
      programId: 'prg-relay',
    });
    expect(events[0]?.key?.toString()).toBe('bank-a:prg-relay');
  });
});
