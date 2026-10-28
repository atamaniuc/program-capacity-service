export interface InvariantMismatch {
  readonly tenantId: string;
  readonly programId: string;
  readonly reservedMinor: bigint;
  /** Σ(amount − released) of reservations that are not RELEASED. */
  readonly reservationsMinor: bigint;
  /** Σ ledger `delta_reserved_minor`. */
  readonly ledgerMinor: bigint;
}

export interface RetentionPolicy {
  readonly idempotencyKeyMaxAgeSeconds: number;
  readonly inboxMaxAgeSeconds: number;
  readonly outboxPublishedMaxAgeSeconds: number;
}

export interface RetentionResult {
  readonly idempotencyKeys: number;
  readonly inboxMessages: number;
  readonly outboxEvents: number;
}

/** Scheduled maintenance queries run by the worker role (FR-15, NFR-11). */
export interface MaintenanceStore {
  /** Programs whose reserved total disagrees with their reservations or their ledger (I1). */
  findInvariantMismatches(): Promise<readonly InvariantMismatch[]>;
  deleteExpired(policy: RetentionPolicy): Promise<RetentionResult>;
}
