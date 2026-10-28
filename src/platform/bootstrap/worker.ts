import { TreasuryConsumerRunner } from '#src/capacity/adapters/in/kafka/consumer-runner.js';
import { TreasuryMessageHandler } from '#src/capacity/adapters/in/kafka/treasury-handler.js';
import type { Persistence } from '#src/capacity/adapters/out/postgres/db.js';
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

/** Clock-skew margin of the no-watermark reconciliation fallback (PRD §8). */
const RECON_SKEW_MS = 5 * 60 * 1000;

/** The worker role's treasury consumer: use cases, ACL handler and runner, wired to PostgreSQL. */
export function createTreasuryConsumer(
  config: Config,
  persistence: Persistence,
  logger: Logger,
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
  });
}
