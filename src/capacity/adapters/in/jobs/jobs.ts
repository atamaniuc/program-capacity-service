import type {
  InvariantMismatch,
  MaintenanceStore,
  OperationalMetrics,
  RetentionPolicy,
  RetentionResult,
} from '#src/capacity/application/ports/index.js';

export interface JobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * FR-15: recompute `reserved` from the open reservations and from the ledger and report every
 * program where the three numbers disagree (I1). Reporting only: nothing is repaired here.
 */
export class InvariantCheckJob {
  constructor(
    private readonly store: MaintenanceStore,
    private readonly logger: JobLogger,
    private readonly metrics?: OperationalMetrics,
  ) {}

  async run(): Promise<readonly InvariantMismatch[]> {
    const mismatches = await this.store.findInvariantMismatches();
    this.metrics?.setInvariantMismatches(mismatches.length);
    this.metrics?.setProgramsOverLimit(await this.store.countOverLimitPrograms());
    for (const mismatch of mismatches) {
      this.logger.error(
        {
          event: 'invariant-mismatch',
          tenantId: mismatch.tenantId,
          programId: mismatch.programId,
          reservedMinor: mismatch.reservedMinor.toString(),
          reservationsMinor: mismatch.reservationsMinor.toString(),
          ledgerMinor: mismatch.ledgerMinor.toString(),
        },
        'program reserved total disagrees with its reservations or ledger',
      );
    }
    return mismatches;
  }
}

/** Defaults of NFR-11 and PRD §8: keys 24 h, inbox and published outbox rows 7 days. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  idempotencyKeyMaxAgeSeconds: 24 * 3600,
  inboxMaxAgeSeconds: 7 * 86_400,
  outboxPublishedMaxAgeSeconds: 7 * 86_400,
};

export class RetentionCleanupJob {
  constructor(
    private readonly store: MaintenanceStore,
    private readonly logger: JobLogger,
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION,
    private readonly metrics?: OperationalMetrics,
  ) {}

  async run(): Promise<RetentionResult> {
    const result = await this.store.deleteExpired(this.policy);
    this.metrics?.addRetentionDeleted('idempotency_key', result.idempotencyKeys);
    this.metrics?.addRetentionDeleted('inbox_message', result.inboxMessages);
    this.metrics?.addRetentionDeleted('outbox_event', result.outboxEvents);
    this.logger.info({ event: 'retention-cleanup', ...result }, 'retention cleanup finished');
    return result;
  }
}

export interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<unknown>;
}

/** Runs each job once at start, then on its interval; a failing run is logged, never fatal. */
export class JobScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly jobs: readonly ScheduledJob[],
    private readonly logger: JobLogger,
  ) {}

  start(): void {
    for (const job of this.jobs) {
      this.track(job);
      const timer = setInterval(() => {
        this.track(job);
      }, job.intervalMs);
      timer.unref();
      this.timers.push(timer);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    await Promise.all(this.inFlight);
  }

  private track(job: ScheduledJob): void {
    if (this.stopped) return;
    const running = job
      .run()
      .then(
        () => undefined,
        (error: unknown) => {
          this.logger.error({ job: job.name, error: String(error) }, 'scheduled job failed');
        },
      )
      .finally(() => {
        this.inFlight.delete(running);
      });
    this.inFlight.add(running);
  }
}
