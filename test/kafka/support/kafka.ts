import { createServer } from 'node:net';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/** The image compose runs; `KafkaContainer` of @testcontainers/kafka only drives Confluent images. */
export const KAFKA_IMAGE = 'apache/kafka:4.2.0';

export interface TestKafka {
  readonly brokers: string;
  createTopics(topics: readonly string[], partitions?: number): Promise<void>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** A single-node KRaft broker whose advertised port equals the published host port. */
export async function startKafka(): Promise<TestKafka> {
  const port = await freePort();
  const container: StartedTestContainer = await new GenericContainer(KAFKA_IMAGE)
    .withExposedPorts({ container: 29092, host: port })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,EXTERNAL://:29092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:9092,EXTERNAL://localhost:${port}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start();
  const brokers = `localhost:${port}`;
  return {
    brokers,
    createTopics: async (topics, partitions = 1) => {
      const kafka = new KafkaJS.Kafka({
        kafkaJS: { brokers: [brokers], logLevel: KafkaJS.logLevel.ERROR },
      });
      const admin = kafka.admin();
      await admin.connect();
      try {
        await admin.createTopics({
          topics: topics.map((topic) => ({
            topic,
            numPartitions: partitions,
            replicationFactor: 1,
          })),
        });
      } finally {
        await admin.disconnect();
      }
    },
    stop: async () => {
      await container.stop();
    },
  };
}
