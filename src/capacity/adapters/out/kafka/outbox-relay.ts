import type {
  EventPublisher,
  OperationalMetrics,
  OutboxRelayStore,
  RelayLease,
} from '#src/capacity/application/ports/index.js';

export interface RelayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface OutboxRelayOptions {
  readonly store: OutboxRelayStore;
  readonly publisher: EventPublisher;
  /** Identifies this process in the lease row. */
  readonly owner: string;
  readonly logger: RelayLogger;
  readonly metrics?: OperationalMetrics;
  /** PRD §8: 30 s, renewed on every batch. */
  readonly leaseTtlMs?: number;
  readonly batchSize?: number;
  /** Pause between cycles when there is nothing to send or this process is not the holder. */
  readonly idleIntervalMs?: number;
}

export type RelayCycle =
  | { readonly state: 'standby' }
  | { readonly state: 'idle' }
  | { readonly state: 'published'; readonly count: number }
  /** The broker refused or timed out; nothing was marked, the rows go out again next cycle. */
  | { readonly state: 'publish-failed' }
  /** Another holder took the lease while this one was sending; its late mark was rejected. */
  | { readonly state: 'fenced'; readonly sent: number };

/**
 * Publishes committed outbox rows to Kafka, in (tenant, program, program_seq) order, while it
 * holds the single relay lease (PRD §8). Delivery is at least once: a crash or a fenced batch
 * can repeat events, which consumers drop by event id.
 */
export class OutboxRelay {
  private readonly leaseTtlMs: number;
  private readonly batchSize: number;
  private readonly idleIntervalMs: number;
  private lease: RelayLease | null = null;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: OutboxRelayOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.batchSize = options.batchSize ?? 200;
    this.idleIntervalMs = options.idleIntervalMs ?? 500;
  }

  /** The epoch this instance currently holds, or null when it is on standby. */
  heldEpoch(): bigint | null {
    return this.lease?.epoch ?? null;
  }

  /** One lease check plus at most one batch. */
  async runOnce(): Promise<RelayCycle> {
    const { store, publisher, owner, logger } = this.options;
    if (!(await this.holdLease())) {
      await this.reportLag();
      return { state: 'standby' };
    }
    const lease = this.lease as RelayLease;
    const batch = await store.fetchUnpublished(this.batchSize);
    if (batch.length === 0) {
      await this.reportLag();
      return { state: 'idle' };
    }
    try {
      await publisher.publish(batch);
    } catch (error) {
      logger.error({ error: String(error), batch: batch.length }, 'outbox publish failed');
      await this.reportLag();
      return { state: 'publish-failed' };
    }
    const marked = await store.markPublished(
      batch.map((record) => record.id),
      owner,
      lease.epoch,
    );
    if (marked === 0) {
      logger.warn({ epoch: String(lease.epoch), sent: batch.length }, 'outbox lease lost');
      this.lease = null;
      await this.reportLag();
      return { state: 'fenced', sent: batch.length };
    }
    await this.reportLag();
    return { state: 'published', count: marked };
  }

  start(): void {
    if (this.loop !== null) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Stops the loop, hands the lease back so another worker takes over at once, closes Kafka. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = null;
    if (this.lease !== null) {
      await this.options.store.releaseLease(this.options.owner, this.lease.epoch).catch(() => {
        // The lease expires after its TTL anyway.
      });
      this.lease = null;
    }
    await this.options.publisher.close().catch(() => {
      // Closing a producer that never connected is not an error worth failing shutdown for.
    });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let pause = this.idleIntervalMs;
      try {
        const cycle = await this.runOnce();
        if (cycle.state === 'published') pause = 0;
      } catch (error) {
        // Database trouble: keep looping, the readiness probe reports it.
        this.options.logger.warn({ error: String(error) }, 'outbox relay cycle failed');
        this.lease = null;
      }
      if (pause > 0 && !this.stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pause);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }

  /** Renews the lease I hold (every cycle, i.e. every batch) or tries to take it over. */
  private async holdLease(): Promise<boolean> {
    const { store, owner, logger } = this.options;
    if (this.lease !== null) {
      if (await store.renewLease(owner, this.lease.epoch, this.leaseTtlMs)) return true;
      logger.warn({ epoch: String(this.lease.epoch) }, 'outbox lease expired or taken over');
      this.lease = null;
    }
    const acquired = await store.acquireLease(owner, this.leaseTtlMs);
    if (acquired === null) return false;
    this.lease = acquired;
    logger.info({ epoch: String(acquired.epoch), owner }, 'outbox relay lease acquired');
    return true;
  }

  private async reportLag(): Promise<void> {
    if (this.options.metrics === undefined) return;
    try {
      this.options.metrics.setOutboxLag(await this.options.store.lag());
    } catch {
      // A metric must never break the relay.
    }
  }
}
