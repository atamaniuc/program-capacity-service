import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { TreasuryLogger } from '#src/capacity/application/shared/treasury-errors.js';
import { classify } from './errors.js';
import type { MessageHandler, RawMessage } from './treasury-handler.js';

export interface RunnerOptions {
  readonly brokers: readonly string[];
  readonly groupId: string;
  readonly topics: readonly string[];
  readonly handler: MessageHandler;
  readonly logger: TreasuryLogger;
  readonly clientId?: string;
  /** Partitions processed in parallel; each partition still has one message in flight. */
  readonly concurrency?: number;
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
}

export interface RunnerState {
  readonly running: boolean;
  /** Partitions currently waiting out a transient failure. */
  readonly pausedPartitions: number;
  readonly lastError: string | null;
}

const DEFAULT_BACKOFF = { baseMs: 250, maxMs: 10_000 };
/** NFR-07: SIGTERM drain budget for in-flight messages before the consumer disconnects. */
const DRAIN_TIMEOUT_MS = 25_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consumer runner (PRD §8, CP-3). Per record: the handler runs one DB transaction; only after
 * it commits is the Kafka offset committed (`autoCommit` off). A permanent failure publishes the
 * original bytes to `<topic>.dlq` and then commits; a transient one pauses the partition,
 * backs off and retries the same record without committing anything.
 */
export class TreasuryConsumerRunner {
  private readonly kafka: KafkaJS.Kafka;
  private consumer: KafkaJS.Consumer | null = null;
  private producer: KafkaJS.Producer | null = null;
  private stopping = false;
  private running = false;
  private paused = 0;
  private lastError: string | null = null;
  private wake: (() => void) | null = null;
  private readonly committed = new Map<string, bigint>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly options: RunnerOptions) {
    this.kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: [...options.brokers],
        clientId: options.clientId ?? 'program-capacity-worker',
        logLevel: KafkaJS.logLevel.ERROR,
      },
    });
  }

  async start(): Promise<void> {
    this.producer = this.kafka.producer({ kafkaJS: { acks: -1 } });
    this.consumer = this.kafka.consumer({
      kafkaJS: {
        groupId: this.options.groupId,
        fromBeginning: true,
        autoCommit: false,
      },
    });
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [...this.options.topics] });
    await this.consumer.run({
      partitionsConsumedConcurrently: this.options.concurrency ?? 3,
      eachMessage: async ({ topic, partition, message }) => {
        if (this.stopping) return;
        const task = this.process({
          topic,
          partition,
          offset: BigInt(message.offset),
          key: message.key,
          value: message.value,
        });
        // The set holds a promise that never rejects, so `stop()` can race it safely.
        const tracked = task.then(
          () => undefined,
          () => undefined,
        );
        this.inflight.add(tracked);
        try {
          await task;
        } finally {
          this.inflight.delete(tracked);
        }
      },
    });
    this.running = true;
  }

  state(): RunnerState {
    return {
      running: this.running && !this.stopping,
      pausedPartitions: this.paused,
      lastError: this.lastError,
    };
  }

  /** Readiness (NFR-06): the consumer is part of the service only while it is running. */
  check(): Promise<void> {
    return this.state().running
      ? Promise.resolve()
      : Promise.reject(new Error('treasury consumer is not running'));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    this.running = false;
    // NFR-07: wait for in-flight messages to finish and commit their offsets, with a bounded
    // drain, then disconnect. A message still blocked after the budget is left for a redelivery.
    await this.drainInflight();
    await this.consumer?.disconnect().catch(() => undefined);
    await this.producer?.disconnect().catch(() => undefined);
  }

  private async drainInflight(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.inflight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await Promise.race([...this.inflight, delay(remaining)]);
    }
  }

  private async process(raw: RawMessage): Promise<void> {
    const backoff = this.options.backoff ?? DEFAULT_BACKOFF;
    let attempt = 0;
    for (;;) {
      try {
        await this.options.handler.handle(raw);
        break;
      } catch (error) {
        const failure = classify(error);
        if (failure.kind === 'permanent') {
          try {
            await this.publishToDlq(raw, failure.code, failure.message);
            this.options.logger.warn(
              {
                event: 'dlq',
                topic: raw.topic,
                partition: raw.partition,
                offset: raw.offset.toString(),
                code: failure.code,
              },
              `message parked in ${raw.topic}.dlq: ${failure.message}`,
            );
            break;
          } catch (dlqError) {
            // The record cannot be parked right now; treat it as transient so nothing is lost.
            this.lastError = `dlq publish failed: ${String(dlqError)}`;
          }
        } else {
          this.lastError = failure.message;
        }
        if (this.stopping) return;
        attempt += 1;
        const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(attempt - 1, 10));
        this.options.logger.warn(
          {
            event: 'transient-failure',
            topic: raw.topic,
            partition: raw.partition,
            offset: raw.offset.toString(),
            attempt,
            delayMs: delay,
          },
          `transient failure, partition paused: ${this.lastError ?? ''}`,
        );
        await this.pauseAndWait(raw, delay);
        if (this.stopping) return;
      }
    }
    this.lastError = null;
    const next = raw.offset + 1n;
    await this.consumer?.commitOffsets([
      { topic: raw.topic, partition: raw.partition, offset: next.toString() },
    ]);
    this.committed.set(`${raw.topic}/${raw.partition}`, next);
  }

  /** The next offset this process committed for a partition, or 0 before the first commit. */
  committedOffset(topic: string, partition = 0): bigint {
    return this.committed.get(`${topic}/${partition}`) ?? 0n;
  }

  private async pauseAndWait(raw: RawMessage, delayMs: number): Promise<void> {
    const target = [{ topic: raw.topic, partitions: [raw.partition] }];
    this.paused += 1;
    try {
      this.consumer?.pause(target);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    } finally {
      this.wake = null;
      this.paused -= 1;
      try {
        this.consumer?.resume(target);
      } catch {
        // The consumer may already be closing.
      }
    }
  }

  private async publishToDlq(raw: RawMessage, code: string, message: string): Promise<void> {
    if (this.producer === null) throw new Error('producer is not connected');
    await this.producer.send({
      topic: `${raw.topic}.dlq`,
      messages: [
        {
          key: raw.key,
          value: raw.value,
          headers: {
            'x-error-code': code,
            'x-error-message': message.slice(0, 1000),
            'x-original-topic': raw.topic,
            'x-original-partition': String(raw.partition),
            'x-original-offset': raw.offset.toString(),
          },
        },
      ],
    });
  }
}
