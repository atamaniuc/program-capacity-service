import { type LedgerEntry, type Program, type Reservation } from '#src/capacity/domain/index.js';
import type { Clock, IdGenerator, TreasuryScope, TreasuryUnitOfWork } from '../../ports/index.js';
import {
  PermanentError,
  type MessageSource,
  type TreasuryLogger,
  type TreasuryResult,
} from '../../shared/treasury-errors.js';
import { moneyOf, type ProgramReconciled } from '../../shared/treasury-messages.js';
import { capacityView } from '../../shared/views.js';
import {
  planReconciliation,
  type Drift,
  type ReconcilePlan,
  type ReconcilePolicy,
  type Snapshot,
  type SnapshotReservation,
} from './policy.js';

export interface ReconcileProgramDeps {
  readonly uow: TreasuryUnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: TreasuryLogger;
  readonly policy: ReconcilePolicy;
  /** Snapshots above this size go to the DLQ (RECON_MAX_RESERVATIONS). */
  readonly maxReservations: number;
  /** Test seam: runs after the diff is planned and before the program lock is taken. */
  readonly betweenPlanAndLock?: (() => Promise<void>) | undefined;
}

export type ReconcileResult =
  | Skipped
  | {
      readonly status: 'applied';
      readonly plan: ReconcilePlan;
      /** The program moved between planning and locking, so the diff was computed again. */
      readonly recomputed: boolean;
    };

type Skipped = Exclude<TreasuryResult, { status: 'applied' }>;

interface Prepared {
  readonly basedOnVersion: number;
  readonly plan: ReconcilePlan;
  readonly snapshot: Snapshot;
}

const ACTOR = 'treasury';

/**
 * Reconciliation (PRD §8, CP-4). The diff is planned outside the program lock from plain reads;
 * under the lock the version is checked again and the plan is recomputed if the program moved,
 * then applied with set-based statements.
 */
export class ReconcileProgram {
  constructor(private readonly deps: ReconcileProgramDeps) {}

  async execute(source: MessageSource, message: ProgramReconciled): Promise<ReconcileResult> {
    const { uow } = this.deps;
    // The size cap is a resource guard and runs before everything, so an oversized snapshot
    // is parked in the DLQ even when its seq is stale. Duplicate and stale checks then run
    // before the remaining payload validation: a stale snapshot with a semantic defect is
    // skipped as stale, never parked (AC-09).
    const reservationCount = message.payload.reservations.length;
    if (reservationCount > this.deps.maxReservations) {
      throw new PermanentError(
        'snapshot-too-large',
        `${reservationCount} reservations exceed RECON_MAX_RESERVATIONS ${this.deps.maxReservations}`,
      );
    }
    const prepared = await uow.run(async (tx): Promise<Prepared | Skipped> => {
      if (await tx.inbox.seen(source.consumer, message.messageId)) return { status: 'duplicate' };
      const program = await tx.treasuryPrograms.find(message.tenantId, message.programId);
      if (program === null) {
        throw new PermanentError('unknown-program', `${message.tenantId}:${message.programId}`);
      }
      if (message.seq <= program.treasurySeq) {
        return { status: 'stale', treasurySeq: program.treasurySeq };
      }
      // Duplicate and stale checks precede the remaining payload validation (AC-09).
      const snapshot = this.snapshotOf(message);
      this.limitOf(message, program.currency);
      const plan = await this.plan(tx, program, snapshot);
      return { basedOnVersion: program.version, plan, snapshot };
    });
    if (!('plan' in prepared)) return this.skipped(source, message, prepared);

    await this.deps.betweenPlanAndLock?.();

    const outcome = await uow.run((tx) =>
      this.apply(tx, source, message, prepared.snapshot, prepared),
    );
    if (outcome.status !== 'applied') return this.skipped(source, message, outcome);
    this.report(message, outcome.plan);
    return outcome;
  }

  private async apply(
    tx: TreasuryScope,
    source: MessageSource,
    message: ProgramReconciled,
    snapshot: Snapshot,
    prepared: Prepared,
  ): Promise<ReconcileResult> {
    const { tenantId, programId, messageId, seq } = message;
    if (!(await tx.inbox.claim(source, messageId))) return { status: 'duplicate' };
    const program = await tx.programs.lockForUpdate(tenantId, programId);
    if (program === null) throw new PermanentError('unknown-program', `${tenantId}:${programId}`);
    if (seq <= program.treasurySeq) return { status: 'stale', treasurySeq: program.treasurySeq };

    const recomputed = program.version !== prepared.basedOnVersion;
    const plan = recomputed ? await this.plan(tx, program, snapshot) : prepared.plan;
    const limitMinor = this.limitOf(message, program.currency);
    const limitChanged = limitMinor !== program.creditLimitMinor;
    const capacityChanged =
      limitChanged ||
      plan.overwrites.length > 0 ||
      plan.adoptions.length > 0 ||
      plan.deltaReservedMinor !== 0n;

    const now = this.deps.clock.now();
    const adopted: Reservation[] = plan.adoptions.map((adoption) => ({
      id: this.deps.ids.next(),
      tenantId,
      programId,
      invoiceId: adoption.invoiceId,
      invoiceAmount: { minor: adoption.invoiceAmountMinor, currency: adoption.invoiceCurrency },
      fx: { rate: adoption.rate, source: 'treasury-snapshot', at: snapshot.asOf },
      amountMinor: adoption.amountMinor,
      releasedMinor: 0n,
      releasedInvoiceMinor: 0n,
      status: 'ACTIVE',
      origin: 'TREASURY',
      platformSeq: 0,
      createdAt: now,
    }));

    let updated: Program = program;
    if (capacityChanged) {
      updated = await tx.treasuryPrograms.applyChange(tenantId, programId, {
        creditLimitMinor: limitChanged ? limitMinor : undefined,
        reservedDeltaMinor: plan.deltaReservedMinor,
        treasurySeq: seq,
      });
      // I1: reserved is the sum of the open outstanding amounts, so the plan's delta must land.
      if (updated.reservedMinor !== program.reservedMinor + plan.deltaReservedMinor) {
        throw new Error('invariant I1: reserved moved differently from the reconciliation plan');
      }
      await tx.treasuryReservations.overwrite(
        tenantId,
        programId,
        plan.overwrites.map((overwrite) => ({
          id: overwrite.reservationId,
          invoiceAmountMinor: overwrite.invoiceAmountMinor,
          amountMinor: overwrite.amountMinor,
          releasedInvoiceMinor: overwrite.releasedInvoiceMinor,
          releasedMinor: overwrite.releasedMinor,
          status: overwrite.status,
        })),
      );
      await tx.treasuryReservations.insertMany(
        adopted.map((reservation) => ({ ...reservation, platformSeq: updated.platformSeq })),
      );
      await tx.ledgerBatch.appendMany(this.ledgerOf(program, limitMinor, plan, adopted, messageId));
      await tx.outbox.append({
        tenantId,
        programId,
        programSeq: updated.platformSeq,
        type: 'ProgramCapacityChanged',
        payload: {
          tenantId,
          programId,
          programSeq: updated.platformSeq,
          cause: 'reconciliation',
          snapshotSeq: seq,
          capacity: capacityView(updated),
        },
      });
    }
    if (plan.drifts.length > 0) {
      const withDrift = await tx.treasuryPrograms.applyChange(tenantId, programId, {
        treasurySeq: seq,
      });
      await tx.outbox.append({
        tenantId,
        programId,
        programSeq: withDrift.platformSeq,
        type: 'ReconciliationDriftDetected',
        payload: {
          tenantId,
          programId,
          programSeq: withDrift.platformSeq,
          snapshotSeq: seq,
          asOf: snapshot.asOf.toISOString(),
          mode: this.deps.policy.mode,
          drifts: plan.drifts.map(driftView),
        },
      });
    } else if (!capacityChanged) {
      await tx.treasuryPrograms.markTreasurySeq(tenantId, programId, seq);
    }
    return { status: 'applied', plan, recomputed };
  }

  /** One ledger entry per change of limit or reserved (I5), with running totals. */
  private ledgerOf(
    program: Program,
    limitMinor: bigint,
    plan: ReconcilePlan,
    adopted: readonly Reservation[],
    messageId: string,
  ): LedgerEntry[] {
    const entries: LedgerEntry[] = [];
    let reserved = program.reservedMinor;
    const base = {
      tenantId: program.tenantId,
      programId: program.id,
      causeType: 'kafka',
      causeId: messageId,
      actor: ACTOR,
    };
    if (limitMinor !== program.creditLimitMinor) {
      entries.push({
        ...base,
        reservationId: null,
        kind: 'LIMIT_SET',
        deltaReservedMinor: 0n,
        deltaLimitMinor: limitMinor - program.creditLimitMinor,
        limitAfter: limitMinor,
        reservedAfter: reserved,
      });
    }
    const adjust = (reservationId: string, delta: bigint): void => {
      reserved += delta;
      entries.push({
        ...base,
        reservationId,
        kind: 'RECON_ADJUST',
        deltaReservedMinor: delta,
        deltaLimitMinor: 0n,
        limitAfter: limitMinor,
        reservedAfter: reserved,
      });
    };
    for (const overwrite of plan.overwrites) {
      adjust(overwrite.reservationId, overwrite.deltaReservedMinor);
    }
    for (const reservation of adopted) adjust(reservation.id, reservation.amountMinor);
    return entries;
  }

  private snapshotOf(message: ProgramReconciled): Snapshot {
    const { reservations, platformWatermark, asOf } = message.payload;
    if (reservations.length > this.deps.maxReservations) {
      throw new PermanentError(
        'snapshot-too-large',
        `${reservations.length} reservations exceed RECON_MAX_RESERVATIONS ${this.deps.maxReservations}`,
      );
    }
    const seen = new Set<string>();
    return {
      asOf: new Date(asOf),
      platformWatermark: platformWatermark ?? null,
      reservations: reservations.map((entry) => {
        if (seen.has(entry.invoiceId)) {
          throw new PermanentError(
            'invalid-snapshot',
            `invoice ${entry.invoiceId} is listed twice`,
          );
        }
        seen.add(entry.invoiceId);
        const invoice = moneyOf(entry.outstandingInvoiceAmount);
        const program = moneyOf(entry.outstandingReservedAmount);
        if (invoice.minor <= 0n || program.minor <= 0n) {
          throw new PermanentError(
            'invalid-snapshot',
            `invoice ${entry.invoiceId} is listed as open with nothing outstanding`,
          );
        }
        return {
          invoiceId: entry.invoiceId,
          invoiceCurrency: invoice.currency,
          outstandingInvoiceMinor: invoice.minor,
          outstandingProgramMinor: program.minor,
        };
      }),
    };
  }

  private limitOf(message: ProgramReconciled, programCurrency: string): bigint {
    const limit = moneyOf(message.payload.creditLimit);
    if (limit.currency !== programCurrency) {
      throw new PermanentError('currency-mismatch', `snapshot limit is in ${limit.currency}`);
    }
    return limit.minor;
  }

  private async plan(
    tx: TreasuryScope,
    program: Program,
    snapshot: Snapshot,
  ): Promise<ReconcilePlan> {
    // The snapshot goes into the staging table and the set-based diff query partitions the
    // reservations into matched, treasury-only and ours-only rows outside the program lock.
    await tx.treasuryReservations.loadSnapshot(
      program.tenantId,
      program.id,
      snapshot.reservations.map((entry) => ({
        invoiceId: entry.invoiceId,
        invoiceCurrency: entry.invoiceCurrency,
        outstandingInvoiceMinor: entry.outstandingInvoiceMinor,
        outstandingProgramMinor: entry.outstandingProgramMinor,
      })),
    );
    const rows = await tx.treasuryReservations.diff(program.tenantId, program.id);
    const ours = rows.filter((row) => row.reservation !== null).map((row) => row.reservation!);
    const theirs: SnapshotReservation[] = [];
    for (const row of rows) {
      if (row.snapshot === null) continue;
      if (
        row.reservation !== null &&
        row.reservation.invoiceCurrency !== row.snapshot.invoiceCurrency
      ) {
        throw new PermanentError(
          'invalid-snapshot',
          `invoice ${row.snapshot.invoiceId} is ${row.reservation.invoiceCurrency} here and ${row.snapshot.invoiceCurrency} in the snapshot`,
        );
      }
      theirs.push(row.snapshot);
    }
    return planReconciliation(
      program.currency,
      ours,
      { ...snapshot, reservations: theirs },
      this.deps.policy,
    );
  }

  private skipped(source: MessageSource, message: ProgramReconciled, result: Skipped): Skipped {
    this.deps.logger.info(
      {
        event: result.status === 'stale' ? 'stale-skipped' : 'duplicate-skipped',
        messageId: message.messageId,
        seq: message.seq,
        topic: source.topic,
        programId: message.programId,
      },
      result.status === 'stale' ? 'stale snapshot skipped' : 'duplicate snapshot skipped',
    );
    return result;
  }

  /** Logs after the commit: what was tolerated, what degraded, what needs a human. */
  private report(message: ProgramReconciled, plan: ReconcilePlan): void {
    const { logger } = this.deps;
    const where = { tenantId: message.tenantId, programId: message.programId, seq: message.seq };
    if (plan.usedFallback) {
      logger.warn(
        { ...where, event: 'reconciliation_fallback' },
        'snapshot without platformWatermark: compared asOf with creation time (degraded)',
      );
    }
    for (const note of plan.tolerated) {
      logger.info(
        {
          ...where,
          event: 'within-tolerance',
          invoiceId: note.invoiceId,
          programDiffMinor: note.programDiffMinor.toString(),
        },
        'within-tolerance drift left alone',
      );
    }
    for (const drift of plan.drifts) {
      logger.warn(
        { ...where, event: 'reconciliation-drift', kind: drift.kind, invoiceId: drift.invoiceId },
        'reconciliation drift',
      );
    }
  }
}

function driftView(drift: Drift): Record<string, unknown> {
  const amounts = (side: Drift['ours']) =>
    side === null
      ? null
      : { invoiceMinor: side.invoiceMinor.toString(), programMinor: side.programMinor.toString() };
  return {
    kind: drift.kind,
    invoiceId: drift.invoiceId,
    ours: amounts(drift.ours),
    treasury: amounts(drift.treasury),
  };
}
