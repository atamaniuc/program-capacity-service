import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreasuryConsumerRunner } from './consumer-runner.js';
import type { MessageHandler, RawMessage } from './treasury-handler.js';

type EachMessageEvent = {
  readonly topic: string;
  readonly partition: number;
  readonly message: { offset: string; key: Buffer | null; value: Buffer | null };
};

const mocks = vi.hoisted(() => {
  let eachMessage: ((event: EachMessageEvent) => Promise<void>) | null = null;
  const disconnect = vi.fn(() => Promise.resolve());
  const consumer = {
    connect: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn(() => Promise.resolve()),
    run: vi.fn(
      ({ eachMessage: handler }: { eachMessage: (event: EachMessageEvent) => Promise<void> }) => {
        eachMessage = handler;
        return Promise.resolve();
      },
    ),
    commitOffsets: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => undefined),
    resume: vi.fn(() => undefined),
    disconnect,
  };
  const producer = {
    connect: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
  };
  const Kafka = vi.fn(function KafkaMock() {
    return {
      producer: vi.fn(() => producer),
      consumer: vi.fn(() => consumer),
    };
  });
  return { Kafka, consumer, producer, disconnect, getEachMessage: () => eachMessage };
});

vi.mock('@confluentinc/kafka-javascript', () => ({
  KafkaJS: { Kafka: mocks.Kafka, logLevel: { ERROR: 0 } },
}));

describe('TreasuryConsumerRunner shutdown drain', () => {
  beforeEach(() => {
    mocks.disconnect.mockClear();
    mocks.producer.disconnect.mockClear();
    mocks.consumer.connect.mockClear();
    mocks.consumer.subscribe.mockClear();
    mocks.consumer.run.mockClear();
    mocks.consumer.commitOffsets.mockClear();
    mocks.producer.connect.mockClear();
  });

  it('NFR-07 stop waits for the in-flight message to finish before disconnecting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = vi.fn(() => gate);
    const handler: MessageHandler = { handle };
    const runner = new TreasuryConsumerRunner({
      brokers: ['127.0.0.1:1'],
      groupId: 'test-group',
      topics: ['treasury.capacity.v1'],
      handler,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await runner.start();
    const eachMessage = mocks.getEachMessage();
    expect(eachMessage).not.toBeNull();

    const raw: RawMessage = {
      topic: 'treasury.capacity.v1',
      partition: 0,
      offset: 0n,
      key: Buffer.from('bank-a:prg-drain'),
      value: Buffer.from('{}'),
    };
    const processing = eachMessage?.({
      topic: raw.topic,
      partition: raw.partition,
      message: { offset: raw.offset.toString(), key: raw.key, value: raw.value },
    });
    expect(handle).toHaveBeenCalledTimes(1);

    const stopping = runner.stop();
    expect(mocks.disconnect).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.consumer.commitOffsets).toHaveBeenCalledTimes(1);
    await processing;
  });
});
