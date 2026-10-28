import { Registry } from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDlqMetrics } from '#src/platform/telemetry/metrics.js';
import { PermanentError } from '#src/capacity/application/shared/treasury-errors.js';
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
    mocks.producer.send.mockClear();
    mocks.consumer.pause.mockClear();
    mocks.consumer.resume.mockClear();
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

  it('AC-11 counts a poison message in dlq_messages_total after the DLQ send succeeds', async () => {
    const registry = new Registry();
    const handler: MessageHandler = {
      handle: () => Promise.reject(new PermanentError('schema-invalid', 'not json')),
    };
    const runner = new TreasuryConsumerRunner({
      brokers: ['127.0.0.1:1'],
      groupId: 'test-group',
      topics: ['treasury.capacity.v1'],
      handler,
      logger: { info: vi.fn(), warn: vi.fn() },
      onDlq: createDlqMetrics(registry),
    });
    await runner.start();
    await mocks.getEachMessage()?.({
      topic: 'treasury.capacity.v1',
      partition: 0,
      message: { offset: '5', key: Buffer.from('k'), value: Buffer.from('{bad') },
    });
    expect(mocks.producer.send).toHaveBeenCalledTimes(1);
    expect(await registry.metrics()).toMatch(
      /^dlq_messages_total\{topic="treasury\.capacity\.v1",reason="schema-invalid"\} 1$/m,
    );
    await runner.stop();
  });

  it('NFR-07 stop wakes every paused partition, not only the last one', async () => {
    const handler: MessageHandler = { handle: () => Promise.reject(new Error('db down')) };
    const runner = new TreasuryConsumerRunner({
      brokers: ['127.0.0.1:1'],
      groupId: 'test-group',
      topics: ['treasury.capacity.v1'],
      handler,
      logger: { info: vi.fn(), warn: vi.fn() },
      backoff: { baseMs: 600_000, maxMs: 600_000 },
    });
    await runner.start();
    const eachMessage = mocks.getEachMessage();
    if (eachMessage === null) throw new Error('consumer was not started');
    const deliveries = [0, 1].map((partition) =>
      eachMessage({
        topic: 'treasury.capacity.v1',
        partition,
        message: { offset: '0', key: null, value: Buffer.from('{}') },
      }),
    );
    await vi.waitFor(() => {
      expect(runner.state().pausedPartitions).toBe(2);
    });
    await runner.stop();
    await Promise.all(deliveries);
    expect(runner.state().pausedPartitions).toBe(0);
  });
});
