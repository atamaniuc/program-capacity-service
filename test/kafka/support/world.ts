import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { TreasuryConsumerRunner } from '#src/capacity/adapters/in/kafka/consumer-runner.js';
import { TreasuryMessageHandler } from '#src/capacity/adapters/in/kafka/treasury-handler.js';
import { PostgresTreasuryUnitOfWork } from '#src/capacity/adapters/out/postgres/treasury-unit-of-work.js';
import { systemClock, uuidV7Generator } from '#src/capacity/adapters/out/system/system.js';
import { ApplyTreasuryEvent } from '#src/capacity/application/use-cases/apply-treasury-event/apply-treasury-event.js';
import { IngestFxRate } from '#src/capacity/application/use-cases/ingest-fx-rate/ingest-fx-rate.js';
import { ReconcileProgram } from '#src/capacity/application/use-cases/reconcile-program/reconcile-program.js';
import {
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
} from '#src/capacity/application/shared/treasury-messages.js';
import { startCapacityWorld, type CapacityWorld } from '../../support/capacity-world.js';
import type { ProducedMessage } from '../../../tools/simulator/messages.js';
import { startKafka, type TestKafka } from './kafka.js';

export interface CapturedLog {
  readonly level: 'info' | 'warn';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export interface TreasuryWorld {
  readonly capacity: CapacityWorld;
  readonly kafka: TestKafka;
  readonly runner: TreasuryConsumerRunner;
  readonly logs: CapturedLog[];
  readonly groupId: string;
  send(messages: readonly ProducedMessage[]): Promise<void>;
  /** Sends raw bytes under a key, for records the builders refuse to make. */
  sendRaw(topic: string, key: string, value: Buffer | string): Promise<void>;
  /** Next offset this consumer committed on partition 0 (its own record of successful commits). */
  committedOffset(topic: string): Promise<number>;
  /** What the broker holds for the group on partition 0: the next offset to read, -1 when none. */
  brokerCommittedOffset(topic: string): Promise<number>;
  readTopic(topic: string, count: number, timeoutMs?: number): Promise<KafkaJS.Message[]>;
  close(): Promise<void>;
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false | null>,
  description: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export interface TreasuryWorldOptions {
  readonly reconcile?: {
    maxReservations?: number;
    toleranceMinor?: bigint;
    mode?: 'HOLD' | 'RELEASE';
  };
  readonly capacityOptions?: Parameters<typeof startCapacityWorld>[0];
}

/** Real PostgreSQL and Kafka, the three treasury use cases, and the running consumer. */
export async function startTreasuryWorld(
  options: TreasuryWorldOptions = {},
): Promise<TreasuryWorld> {
  const [capacity, kafka] = await Promise.all([
    startCapacityWorld(options.capacityOptions),
    startKafka(),
  ]);
  await kafka.createTopics([
    TOPIC_CAPACITY,
    TOPIC_FX_RATES,
    `${TOPIC_CAPACITY}.dlq`,
    `${TOPIC_FX_RATES}.dlq`,
  ]);
  const logs: CapturedLog[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) =>
      logs.push({ level: 'info', fields, message }),
    warn: (fields: Record<string, unknown>, message: string) =>
      logs.push({ level: 'warn', fields, message }),
  };
  const uow = new PostgresTreasuryUnitOfWork(capacity.persistence);
  const handler = new TreasuryMessageHandler({
    apply: new ApplyTreasuryEvent({ uow, ids: uuidV7Generator, logger }),
    reconcile: new ReconcileProgram({
      uow,
      clock: systemClock,
      ids: uuidV7Generator,
      logger,
      policy: {
        toleranceMinor: options.reconcile?.toleranceMinor ?? 1n,
        mode: options.reconcile?.mode ?? 'HOLD',
        skewMs: 5 * 60 * 1000,
      },
      maxReservations: options.reconcile?.maxReservations ?? 50_000,
    }),
    ingestFx: new IngestFxRate({ uow, logger }),
  });
  const groupId = `test-${randomUUID()}`;
  const runner = new TreasuryConsumerRunner({
    brokers: [kafka.brokers],
    groupId,
    topics: [TOPIC_CAPACITY, TOPIC_FX_RATES],
    handler,
    logger,
    backoff: { baseMs: 100, maxMs: 500 },
  });
  await runner.start();

  const client = new KafkaJS.Kafka({
    kafkaJS: { brokers: [kafka.brokers], logLevel: KafkaJS.logLevel.ERROR },
  });
  const producer = client.producer({ kafkaJS: { acks: -1 } });
  await producer.connect();
  const sendRaw = async (topic: string, key: string, value: Buffer | string) => {
    await producer.send({ topic, messages: [{ key, value }] });
  };

  return {
    capacity,
    kafka,
    runner,
    logs,
    groupId,
    send: async (messages) => {
      for (const message of messages) await sendRaw(message.topic, message.key, message.value);
    },
    sendRaw,
    committedOffset: (topic) => Promise.resolve(Number(runner.committedOffset(topic))),
    brokerCommittedOffset: async (topic) => {
      const admin = client.admin();
      await admin.connect();
      try {
        const groups = await admin.fetchOffsets({ groupId, topics: [topic] });
        const partition = groups
          .flatMap((entry) => entry.partitions)
          .find((p) => p.partition === 0);
        return Number(partition?.offset ?? -1);
      } finally {
        await admin.disconnect();
      }
    },
    readTopic: async (topic, count, timeoutMs = 30_000) => {
      const consumer = client.consumer({
        kafkaJS: { groupId: `read-${randomUUID()}`, fromBeginning: true, autoCommit: false },
      });
      await consumer.connect();
      await consumer.subscribe({ topics: [topic] });
      const seen: KafkaJS.Message[] = [];
      await consumer.run({
        eachMessage: ({ message }) => {
          seen.push({
            key: message.key,
            value: message.value,
            headers: message.headers as KafkaJS.IHeaders,
          });
          return Promise.resolve();
        },
      });
      try {
        await waitFor(
          () => Promise.resolve(seen.length >= count ? true : undefined),
          `${count} record(s) on ${topic}`,
          timeoutMs,
        );
      } finally {
        await consumer.disconnect();
      }
      return seen;
    },
    close: async () => {
      await runner.stop();
      await producer.disconnect();
      await Promise.all([capacity.close(), kafka.stop()]);
    },
  };
}
