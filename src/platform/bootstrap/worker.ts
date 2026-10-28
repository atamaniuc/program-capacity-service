import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Registry } from 'prom-client';
import {
  InvariantCheckJob,
  JobScheduler,
  RetentionCleanupJob,
} from '#src/capacity/adapters/in/jobs/jobs.js';
import { KafkaEventPublisher } from '#src/capacity/adapters/out/kafka/event-publisher.js';
import { OutboxRelay } from '#src/capacity/adapters/out/kafka/outbox-relay.js';
import type { Persistence } from '#src/capacity/adapters/out/postgres/db.js';
import { PgMaintenanceStore } from '#src/capacity/adapters/out/postgres/repositories/maintenance.repository.js';
import { PgOutboxRelayStore } from '#src/capacity/adapters/out/postgres/repositories/outbox-relay.repository.js';
import type { Config } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import { createOperationalMetrics } from '../telemetry/metrics.js';
import type { RuntimeSettings } from '../telemetry/settings.js';

export interface WorkerComponents {
  /** Stops intake of new work, waits for the running cycle, hands the relay lease back. */
  stop(): Promise<void>;
}

/** The `worker` role's background components: outbox relay and scheduled jobs (PRD §8). */
export function startWorkerComponents(
  persistence: Persistence,
  config: Config,
  settings: RuntimeSettings,
  logger: Logger,
  registry: Registry,
): WorkerComponents {
  const metrics = createOperationalMetrics(registry);
  const stops: (() => Promise<void>)[] = [];

  if (settings.outboxRelayEnabled) {
    const relay = new OutboxRelay({
      store: new PgOutboxRelayStore(persistence.db),
      publisher: new KafkaEventPublisher({ brokers: config.kafkaBrokers }),
      owner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
      logger,
      metrics,
      leaseTtlMs: settings.outboxLeaseTtlMs,
      batchSize: settings.outboxBatchSize,
      idleIntervalMs: settings.outboxPollIntervalMs,
    });
    relay.start();
    stops.push(() => relay.stop());
  }

  const maintenance = new PgMaintenanceStore(persistence.db);
  const invariant = new InvariantCheckJob(maintenance, logger, metrics);
  const retention = new RetentionCleanupJob(maintenance, logger, settings.retention, metrics);
  const scheduler = new JobScheduler(
    [
      {
        name: 'invariant-check',
        intervalMs: settings.invariantCheckIntervalMs,
        run: () => invariant.run(),
      },
      {
        name: 'retention-cleanup',
        intervalMs: settings.retentionCleanupIntervalMs,
        run: () => retention.run(),
      },
    ],
    logger,
  );
  scheduler.start();
  stops.push(() => scheduler.stop());

  return {
    stop: async () => {
      await Promise.all(stops.map((stop) => stop()));
    },
  };
}
