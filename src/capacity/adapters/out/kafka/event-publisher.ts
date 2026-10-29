import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { EventPublisher, OutboxRecord } from '#src/capacity/application/ports/index.js';
import {
  CAPACITY_EVENTS_TOPIC,
  type CapacityEventEnvelope,
  type CapacityEventHeaders,
} from '#src/capacity/application/shared/capacity-events.js';

export { CAPACITY_EVENTS_TOPIC };

export interface KafkaEventPublisherOptions {
  readonly brokers: readonly string[];
  readonly topic?: string;
  readonly clientId?: string;
  /** Upper bound for connecting and for one delivery report. */
  readonly timeoutMs?: number;
}

/** The common envelope of every Kafka message (PRD §9); the contract is `capacity-events.ts`. */
export function toEnvelope(
  record: OutboxRecord,
): CapacityEventEnvelope & { readonly type: string; readonly payload: unknown } {
  return {
    messageId: record.id,
    type: record.type,
    schemaVersion: 1,
    tenantId: record.tenantId,
    programId: record.programId,
    seq: Number(record.programSeq),
    occurredAt: record.createdAt.toISOString(),
    payload: record.payload,
  };
}

/** Partition key: per-program order needs every event of a program on one partition. */
export function messageKey(record: OutboxRecord): string {
  return `${record.tenantId}:${record.programId}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${ms} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

type Producer = ReturnType<InstanceType<typeof KafkaJS.Kafka>['producer']>;

/**
 * Producer for `capacity.events.v1`. Connects lazily so a missing broker never blocks startup,
 * and drops a broken producer so the next batch reconnects. `publish` resolves only after the
 * broker acknowledged every message (acks=all, idempotent producer).
 */
export class KafkaEventPublisher implements EventPublisher {
  private producer: Producer | null = null;
  private readonly topic: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: KafkaEventPublisherOptions) {
    this.topic = options.topic ?? CAPACITY_EVENTS_TOPIC;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async publish(records: readonly OutboxRecord[]): Promise<void> {
    if (records.length === 0) return;
    try {
      const producer = await this.connected();
      await withTimeout(
        producer.send({
          topic: this.topic,
          // One send keeps the batch order: same key, same partition, same request.
          messages: records.map((record) => ({
            key: messageKey(record),
            value: JSON.stringify(toEnvelope(record)),
            headers: {
              'event-id': record.id,
              'event-type': record.type,
              'schema-version': '1',
              'tenant-id': record.tenantId,
              'program-id': record.programId,
              'program-seq': String(record.programSeq),
              'content-type': 'application/json',
            } satisfies Record<keyof CapacityEventHeaders, string>,
          })),
        }),
        this.timeoutMs,
        'kafka send',
      );
    } catch (error) {
      await this.reset();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async connected(): Promise<Producer> {
    if (this.producer !== null) return this.producer;
    const kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: [...this.options.brokers],
        clientId: this.options.clientId ?? 'capacity-relay',
      },
    });
    const producer = kafka.producer({
      'message.timeout.ms': this.timeoutMs,
      'socket.connection.setup.timeout.ms': this.timeoutMs,
      kafkaJS: { acks: -1, idempotent: true },
    });
    try {
      await withTimeout(producer.connect(), this.timeoutMs, 'kafka connect');
    } catch (error) {
      void producer.disconnect().catch(() => undefined);
      throw error;
    }
    this.producer = producer;
    return producer;
  }

  private async reset(): Promise<void> {
    const producer = this.producer;
    this.producer = null;
    if (producer !== null) await producer.disconnect().catch(() => undefined);
  }
}
