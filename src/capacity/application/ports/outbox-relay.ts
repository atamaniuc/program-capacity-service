/** One committed outbox row, ready to be published to `capacity.events.v1` (FR-13). */
export interface OutboxRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly programId: string;
  readonly programSeq: bigint;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

export interface RelayLease {
  readonly epoch: bigint;
}

export interface OutboxLag {
  readonly unpublished: number;
  readonly oldestAgeSeconds: number;
}

/**
 * Persistence side of the outbox relay. Only the holder of the lease row publishes; every write
 * the holder makes is fenced by its epoch, so a stale holder cannot mark rows published (D7).
 */
export interface OutboxRelayStore {
  /** Takes the lease when free, expired or already mine; a new holder gets `epoch + 1`. */
  acquireLease(owner: string, ttlMs: number): Promise<RelayLease | null>;
  /** Extends my lease; false when it expired or another holder took over. */
  renewLease(owner: string, epoch: bigint, ttlMs: number): Promise<boolean>;
  releaseLease(owner: string, epoch: bigint): Promise<void>;
  /** Oldest unpublished rows, ordered by (tenant, program, program_seq). */
  fetchUnpublished(limit: number): Promise<readonly OutboxRecord[]>;
  /** Marks rows published only while (owner, epoch) still holds an unexpired lease. */
  markPublished(ids: readonly string[], owner: string, epoch: bigint): Promise<number>;
  lag(): Promise<OutboxLag>;
}

/** Outbound event transport; resolves only after the broker acknowledged every record. */
export interface EventPublisher {
  publish(records: readonly OutboxRecord[]): Promise<void>;
  close(): Promise<void>;
}

/** Gauges the relay and the jobs report to; the platform maps them to Prometheus. */
export interface OperationalMetrics {
  setOutboxLag(lag: OutboxLag): void;
  setInvariantMismatches(count: number): void;
  setProgramsOverLimit(count: number): void;
  addRetentionDeleted(table: string, count: number): void;
}
