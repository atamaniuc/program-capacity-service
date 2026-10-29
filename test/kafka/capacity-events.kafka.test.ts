import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { CAPACITY_EVENTS, type ContractMessage } from '#src/platform/contracts/asyncapi.js';
import { CAPACITY_EVENTS_TOPIC } from '#src/capacity/application/shared/capacity-events.js';
import {
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
} from '#src/capacity/application/shared/treasury-messages.js';
import { fxRate, limitSet, repayment, snapshot } from '../../tools/simulator/messages.js';
import { connectProducer, type SimulatorProducer } from '../../tools/simulator/producer.js';
import { contractValidators, type ContractValidators } from '../../tools/contracts/validators.js';
import { startFaultApp, waitFor, type FaultApp } from '../support/fault-app.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';
import { startKafka, type TestKafka } from './support/kafka.js';

interface Received {
  readonly key: string | undefined;
  readonly value: { messageId: string; type: string; seq: number; payload: { programSeq: number } };
  readonly raw: unknown;
  readonly headers: Record<string, string>;
}

const PROGRAM = 'prg-events';
const at = (seq: number) => ({ tenantId: 'bank-a', programId: PROGRAM, seq });

/**
 * The published contract against the real thing: the all role, HTTP and treasury input drive
 * every event type, and each record on capacity.events.v1 is checked against the committed
 * schemas in contracts/json-schema/ and the header schema of contracts/asyncapi.yaml.
 */
describe('capacity.events.v1 contract', () => {
  let postgres: TestPostgres;
  let kafka: TestKafka;
  let service: FaultApp;
  let producer: SimulatorProducer;
  let observer: pg.Client;
  let validators: ContractValidators;

  beforeAll(async () => {
    [postgres, kafka, validators] = await Promise.all([
      startPostgres(),
      startKafka(),
      contractValidators(),
    ]);
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

  const one = async <T>(text: string, params: unknown[] = []): Promise<T | undefined> =>
    (await observer.query<T & pg.QueryResultRow>(text, params)).rows[0];

  const readEvents = async (count: number): Promise<Received[]> => {
    const client = new KafkaJS.Kafka({
      kafkaJS: { brokers: [kafka.brokers], logLevel: KafkaJS.logLevel.ERROR },
    });
    const consumer = client.consumer({
      kafkaJS: { groupId: `contract-${Math.random().toString(36).slice(2)}`, fromBeginning: true },
    });
    const seen: Received[] = [];
    await consumer.connect();
    await consumer.subscribe({ topic: CAPACITY_EVENTS_TOPIC });
    await consumer.run({
      eachMessage: ({ message }) => {
        const raw = JSON.parse(String(message.value)) as unknown;
        seen.push({
          key: message.key?.toString(),
          value: raw as Received['value'],
          raw,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([name, value]) => [name, String(value)]),
          ),
        });
        return Promise.resolve();
      },
    });
    try {
      await waitFor(`${count} events`, () => Promise.resolve(seen.length >= count), 60_000);
    } finally {
      await consumer.disconnect();
    }
    return seen;
  };

  it('FR-13 every event the service publishes matches the published AsyncAPI contract', async () => {
    // 1. Treasury sets the limit (ProgramCapacityChanged, limit-set) and an EUR/USD rate.
    await producer.send([
      fxRate({ base: 'EUR', quote: 'USD', rate: '1.0800000000', asOf: new Date() }),
      limitSet(at(1), { value: '1000000.00', currency: 'USD' }),
    ]);
    await waitFor('the limit and the rate', async () => {
      const program = await one<{ n: string }>(`SELECT count(*) AS n FROM program WHERE id = $1`, [
        PROGRAM,
      ]);
      const rate = await one<{ n: string }>(`SELECT count(*) AS n FROM fx_rate`);
      return program?.n === '1' && rate?.n === '1';
    });

    // 2. Two reservations and a partial release through the API (ReservationCreated, Released).
    const eur = await service.post(
      `/v1/programs/${PROGRAM}/reservations`,
      { invoiceId: 'INV-EVT-1', amount: { value: '100.00', currency: 'EUR' } },
      { 'idempotency-key': 'evt-reserve-1' },
    );
    expect(eur.status).toBe(201);
    const usd = await service.post(`/v1/programs/${PROGRAM}/reservations`, {
      invoiceId: 'INV-EVT-2',
      amount: { value: '200.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
    const eurId = (eur.body as { reservationId: string }).reservationId;
    const released = await service.post(`/v1/programs/${PROGRAM}/reservations/${eurId}/releases`, {
      releaseRef: 'evt-release-1',
      amount: { value: '40.00', currency: 'EUR' },
      reason: 'REPAID',
    });
    expect(released.status).toBe(200);
    const remaining = (released.body as { remainingAmount: { value: string } }).remainingAmount;

    // 3. A treasury repayment (ReservationReleased through the shared release path).
    await producer.send([
      repayment(at(2), {
        invoiceId: 'INV-EVT-2',
        releaseRef: 'treasury-repayment-1',
        amount: { value: '50.00', currency: 'USD' },
      }),
    ]);
    await waitFor('the repayment', async () => {
      const row = await one<{ n: string }>(
        `SELECT count(*) AS n FROM outbox_event WHERE program_id = $1`,
        [PROGRAM],
      );
      return row?.n === '5';
    });

    // 4. A snapshot that raises the limit and omits INV-EVT-2, which treasury has seen
    //    (watermark 5): ProgramCapacityChanged (reconciliation) and ReconciliationDriftDetected.
    await producer.send([
      snapshot(at(3), {
        asOf: new Date(),
        creditLimit: { value: '2000000.00', currency: 'USD' },
        platformWatermark: 5,
        reservations: [
          {
            invoiceId: 'INV-EVT-1',
            outstandingInvoiceAmount: { value: '60.00', currency: 'EUR' },
            outstandingReservedAmount: { value: remaining.value, currency: 'USD' },
          },
        ],
      }),
    ]);

    // At least once: a relay retry may repeat a record, so compare distinct events.
    const events = [
      ...new Map((await readEvents(7)).map((event) => [event.value.messageId, event])).values(),
    ];
    expect(events).toHaveLength(7);
    expect(events.map((event) => event.value.type)).toEqual([
      'ProgramCapacityChanged',
      'ReservationCreated',
      'ReservationCreated',
      'ReservationReleased',
      'ReservationReleased',
      'ProgramCapacityChanged',
      'ReconciliationDriftDetected',
    ]);
    expect(new Set(events.map((event) => event.value.type))).toEqual(new Set(CAPACITY_EVENTS));
    // Gap-free per-program sequence: what treasury echoes back as platformWatermark.
    expect(events.map((event) => event.value.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    for (const event of events) {
      const type = event.value.type as ContractMessage;
      const label = `${type} seq ${event.value.seq}`;
      const committed = validators.committed.get(type);
      const strict = validators.strict.get(type);
      expect(committed?.(event.raw), `${label}: ${validators.errors(committed!)}`).toBe(true);
      // No field outside the contract either: a new field must be added to the schema first.
      expect(strict?.(event.raw), `${label}: ${validators.errors(strict!)}`).toBe(true);
      expect(
        validators.eventHeaders(event.headers),
        `${label}: ${validators.errors(validators.eventHeaders)}`,
      ).toBe(true);
      expect(event.key).toBe(`bank-a:${PROGRAM}`);
      expect(event.headers['event-id']).toBe(event.value.messageId);
      expect(event.headers['event-type']).toBe(type);
      expect(event.headers['program-seq']).toBe(String(event.value.seq));
      expect(event.value.payload.programSeq).toBe(event.value.seq);
      // Optional in the contract only because older events lack it; this code always sends it.
      if (type === 'ProgramCapacityChanged') {
        expect((event.value.payload as { status?: string }).status, label).toBe('ACTIVE');
      }
    }
  });
});
