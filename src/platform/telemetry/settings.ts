import { z } from 'zod';

const seconds = z.coerce.number().positive();

const schema = z.object({
  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  OUTBOX_LEASE_TTL_SECONDS: seconds.default(30),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(200),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
  INVARIANT_CHECK_INTERVAL_SECONDS: seconds.default(300),
  RETENTION_CLEANUP_INTERVAL_SECONDS: seconds.default(3600),
  RETENTION_IDEMPOTENCY_SECONDS: seconds.default(24 * 3600),
  RETENTION_INBOX_SECONDS: seconds.default(7 * 86_400),
  RETENTION_OUTBOX_SECONDS: seconds.default(7 * 86_400),
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/**
 * Worker-side tuning (relay, jobs, retention) and the telemetry switch. Kept apart from the core
 * `Config` so lane 0004 does not edit the file lane 0003 extends; defaults match PRD §8.
 */
export interface RuntimeSettings {
  readonly outboxRelayEnabled: boolean;
  readonly outboxLeaseTtlMs: number;
  readonly outboxBatchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly invariantCheckIntervalMs: number;
  readonly retentionCleanupIntervalMs: number;
  readonly retention: {
    readonly idempotencyKeyMaxAgeSeconds: number;
    readonly inboxMaxAgeSeconds: number;
    readonly outboxPublishedMaxAgeSeconds: number;
  };
  readonly otelEnabled: boolean;
}

export function loadRuntimeSettings(env: Record<string, string | undefined>): RuntimeSettings {
  const data = schema.parse(env);
  return {
    outboxRelayEnabled: data.OUTBOX_RELAY_ENABLED,
    outboxLeaseTtlMs: data.OUTBOX_LEASE_TTL_SECONDS * 1000,
    outboxBatchSize: data.OUTBOX_BATCH_SIZE,
    outboxPollIntervalMs: data.OUTBOX_POLL_INTERVAL_MS,
    invariantCheckIntervalMs: data.INVARIANT_CHECK_INTERVAL_SECONDS * 1000,
    retentionCleanupIntervalMs: data.RETENTION_CLEANUP_INTERVAL_SECONDS * 1000,
    retention: {
      idempotencyKeyMaxAgeSeconds: data.RETENTION_IDEMPOTENCY_SECONDS,
      inboxMaxAgeSeconds: data.RETENTION_INBOX_SECONDS,
      outboxPublishedMaxAgeSeconds: data.RETENTION_OUTBOX_SECONDS,
    },
    otelEnabled: data.OTEL_ENABLED,
  };
}
