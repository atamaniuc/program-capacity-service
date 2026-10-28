import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { ProducedMessage } from './messages.js';

export interface SimulatorProducer {
  send(messages: readonly ProducedMessage[]): Promise<void>;
  close(): Promise<void>;
}

/** Publishes records one at a time, in order, so a scenario's sequence survives the wire. */
export async function connectProducer(brokers: readonly string[]): Promise<SimulatorProducer> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: [...brokers],
      clientId: 'treasury-simulator',
      logLevel: KafkaJS.logLevel.ERROR,
    },
  });
  const producer = kafka.producer({ kafkaJS: { acks: -1 } });
  await producer.connect();
  return {
    send: async (messages) => {
      for (const message of messages) {
        await producer.send({
          topic: message.topic,
          messages: [{ key: message.key, value: message.value }],
        });
      }
    },
    close: () => producer.disconnect(),
  };
}
