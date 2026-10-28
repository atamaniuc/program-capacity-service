import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { freePort } from './app.js';

const run = promisify(execFile);

/** A container whose host port survives `docker stop` / `docker start`, so outages are repeatable. */
export interface StoppableContainer {
  readonly id: string;
  stop(): Promise<void>;
  start(): Promise<void>;
  remove(): Promise<void>;
}

function stoppable(container: StartedTestContainer): StoppableContainer {
  return {
    id: container.getId(),
    stop: async () => {
      await run('docker', ['stop', '-t', '2', container.getId()]);
    },
    start: async () => {
      await run('docker', ['start', container.getId()]);
    },
    remove: async () => {
      await container.stop({ remove: true, timeout: 2_000 }).catch(() => undefined);
    },
  };
}

export interface FixedPostgres extends StoppableContainer {
  readonly url: string;
}

/** PostgreSQL 18 on a fixed host port: the connection URL stays valid across stop and start. */
export async function startFixedPostgres(): Promise<FixedPostgres> {
  const port = await freePort();
  const container = await new GenericContainer('postgres:18')
    .withEnvironment({
      POSTGRES_USER: 'capacity',
      POSTGRES_PASSWORD: 'capacity',
      POSTGRES_DB: 'capacity',
    })
    .withExposedPorts({ container: 5432, host: port })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  return {
    ...stoppable(container),
    url: `postgres://capacity:capacity@127.0.0.1:${port}/capacity`,
  };
}

export interface KafkaBroker extends StoppableContainer {
  readonly brokers: string;
  /** Reads `topic` from the beginning until `count` messages arrived or `timeoutMs` passed. */
  readTopic(topic: string, count: number, timeoutMs?: number): Promise<ReceivedMessage[]>;
}

export interface ReceivedMessage {
  readonly key: string | null;
  readonly value: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly partition: number;
}

/** Single-node KRaft broker (apache/kafka, as in the compose stack) on a fixed host port. */
export async function startKafkaBroker(): Promise<KafkaBroker> {
  const port = await freePort();
  const container = await new GenericContainer('apache/kafka:4.2.0')
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true',
      KAFKA_NUM_PARTITIONS: '3',
    })
    .withExposedPorts({ container: 9092, host: port })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start();
  const brokers = `127.0.0.1:${port}`;

  return {
    ...stoppable(container),
    brokers,
    readTopic: async (topic, count, timeoutMs = 30_000) => {
      const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers: [brokers], clientId: 'test-reader' } });
      const consumer = kafka.consumer({
        kafkaJS: {
          groupId: `reader-${Math.random().toString(36).slice(2)}`,
          fromBeginning: true,
        },
      });
      const received: ReceivedMessage[] = [];
      await consumer.connect();
      await consumer.subscribe({ topic });
      await consumer.run({
        eachMessage: ({ message, partition }) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(message.headers ?? {})) {
            if (value !== undefined) headers[name] = String(value);
          }
          received.push({
            key: message.key === null || message.key === undefined ? null : String(message.key),
            value: JSON.parse(String(message.value)) as Record<string, unknown>,
            headers,
            partition,
          });
          return Promise.resolve();
        },
      });
      const deadline = Date.now() + timeoutMs;
      while (received.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await consumer.disconnect();
      return received;
    },
  };
}
