import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Registry } from 'prom-client';
import {
  InvariantCheckJob,
  JobScheduler,
  RetentionCleanupJob,
} from '#src/capacity/adapters/in/jobs/jobs.js';
import { TreasuryConsumerRunner } from '#src/capacity/adapters/in/kafka/consumer-runner.js';
import { TreasuryMessageHandler } from '#src/capacity/adapters/in/kafka/treasury-handler.js';
import { KafkaEventPublisher } from '#src/capacity/adapters/out/kafka/event-publisher.js';
import { OutboxRelay } from '#src/capacity/adapters/out/kafka/outbox-relay.js';
import type { Persistence } from '#src/capacity/adapters/out/postgres/db.js';
import { PgMaintenanceStore } from '#src/capacity/adapters/out/postgres/repositories/maintenance.repository.js';
import { PgOutboxRelayStore } from '#src/capacity/adapters/out/postgres/repositories/outbox-relay.repository.js';
import { PostgresTreasuryUnitOfWork } from '#src/capacity/adapters/out/postgres/treasury-unit-of-work.js';
import { systemClock, uuidV7Generator } from '#src/capacity/adapters/out/system/system.js';
import {
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
} from '#src/capacity/application/shared/treasury-messages.js';
import { ApplyTreasuryEvent } from '#src/capacity/application/use-cases/apply-treasury-event/apply-treasury-event.js';
import { IngestFxRate } from '#src/capacity/application/use-cases/ingest-fx-rate/ingest-fx-rate.js';
import { ReconcileProgram } from '#src/capacity/application/use-cases/reconcile-program/reconcile-program.js';
import type { Config } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import { createDlqMetrics, createOperationalMetrics } from '../telemetry/metrics.js';
import type { RuntimeSettings } from '../telemetry/settings.js';

/** Clock-skew margin of the no-watermark reconciliation fallback (PRD §8). */
const RECON_SKEW_MS = 5 * 60 * 1000;

/** The worker role's treasury consumer: use cases, ACL handler and runner, wired to PostgreSQL. */
export function createTreasuryConsumer(
  config: Config,
  persistence: Persistence,
  logger: Logger,
  registry: Registry,
  drainTimeoutMs: number,
): TreasuryConsumerRunner {
  const uow = new PostgresTreasuryUnitOfWork(persistence);
  const handler = new TreasuryMessageHandler({
    apply: new ApplyTreasuryEvent({ uow, ids: uuidV7Generator, logger }),
    reconcile: new ReconcileProgram({
      uow,
      clock: systemClock,
      ids: uuidV7Generator,
      logger,
      policy: {
        toleranceMinor: BigInt(config.reconToleranceMinor),
        mode: config.reconMode,
        skewMs: RECON_SKEW_MS,
      },
      maxReservations: config.reconMaxReservations,
    }),
    ingestFx: new IngestFxRate({ uow, logger }),
  });
  return new TreasuryConsumerRunner({
    brokers: config.kafkaBrokers,
    groupId: 'program-capacity-treasury',
    topics: [TOPIC_CAPACITY, TOPIC_FX_RATES],
    handler,
    logger,
    onDlq: createDlqMetrics(registry),
    drainTimeoutMs,
  });
}

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
