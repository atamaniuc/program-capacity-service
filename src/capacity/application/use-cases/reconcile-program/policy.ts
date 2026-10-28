import { FX_RATE_DECIMALS, currencyScale, type FxRate } from '#src/capacity/domain/index.js';
import type { OwnReservation } from '../../ports/index.js';

/** The reconciliation case table of PRD §8 as pure decisions; no I/O, so it is unit-testable. */

export interface SnapshotReservation {
  readonly invoiceId: string;
  readonly invoiceCurrency: string;
  readonly outstandingInvoiceMinor: bigint;
  readonly outstandingProgramMinor: bigint;
}

export interface ReconcilePolicy {
  /** Per-reservation program-currency tolerance in minor units (RECON_TOLERANCE_MINOR). */
  readonly toleranceMinor: bigint;
  readonly mode: 'HOLD' | 'RELEASE';
  /** Clock-skew margin for the no-watermark fallback. */
  readonly skewMs: number;
}

export interface Snapshot {
  readonly asOf: Date;
  readonly platformWatermark: number | null;
  readonly reservations: readonly SnapshotReservation[];
}

/** Treasury wins: the reservation takes the snapshot's outstanding amounts. */
export interface Overwrite {
  readonly reservationId: string;
  readonly invoiceId: string;
  readonly invoiceAmountMinor: bigint;
  readonly amountMinor: bigint;
  readonly releasedInvoiceMinor: bigint;
  readonly releasedMinor: bigint;
  readonly status: 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';
  /** Change of the program's reserved amount. */
  readonly deltaReservedMinor: bigint;
}

export interface Adoption {
  readonly invoiceId: string;
  readonly invoiceCurrency: string;
  readonly invoiceAmountMinor: bigint;
  readonly amountMinor: bigint;
  /** Implied rate, invoice → program currency; the snapshot carries amounts, not a rate. */
  readonly rate: FxRate;
}

export type DriftKind = 'ADJUSTED' | 'ADOPTED' | 'HELD' | 'RELEASED';

export interface Drift {
  readonly kind: DriftKind;
  readonly invoiceId: string;
  readonly ours: { readonly invoiceMinor: bigint; readonly programMinor: bigint } | null;
  readonly treasury: { readonly invoiceMinor: bigint; readonly programMinor: bigint } | null;
}

export interface Tolerated {
  readonly invoiceId: string;
  readonly programDiffMinor: bigint;
}

export interface ReconcilePlan {
  readonly overwrites: readonly Overwrite[];
  readonly adoptions: readonly Adoption[];
  readonly drifts: readonly Drift[];
  readonly tolerated: readonly Tolerated[];
  /** Only-ours reservations kept because treasury has not seen them yet. */
  readonly keptUnseen: number;
  readonly deltaReservedMinor: bigint;
  /** The watermark was absent and `asOf` stood in for it (degraded mode). */
  readonly usedFallback: boolean;
}

export function outstandingOf(reservation: OwnReservation): {
  invoiceMinor: bigint;
  programMinor: bigint;
} {
  return {
    invoiceMinor: reservation.invoiceAmountMinor - reservation.releasedInvoiceMinor,
    programMinor: reservation.amountMinor - reservation.releasedMinor,
  };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Rate that maps the invoice outstanding onto the program outstanding, at least 1e-10. */
export function impliedRate(
  invoiceCurrency: string,
  invoiceMinor: bigint,
  programCurrency: string,
  programMinor: bigint,
): FxRate {
  const invoiceScale = currencyScale(invoiceCurrency) ?? 2;
  const programScale = currencyScale(programCurrency) ?? 2;
  const numerator = programMinor * 10n ** BigInt(FX_RATE_DECIMALS + invoiceScale);
  const denominator = invoiceMinor * 10n ** BigInt(programScale);
  const scaled = numerator / denominator;
  return { scaled: scaled > 0n ? scaled : 1n };
}

/** The reservation reshaped so its outstanding amounts equal treasury's. */
function overwriteTo(own: OwnReservation, treasury: SnapshotReservation): Overwrite {
  const wasProgram = own.amountMinor - own.releasedMinor;
  let invoiceAmountMinor = own.invoiceAmountMinor;
  let releasedInvoiceMinor = own.invoiceAmountMinor - treasury.outstandingInvoiceMinor;
  if (releasedInvoiceMinor < 0n) {
    invoiceAmountMinor = treasury.outstandingInvoiceMinor;
    releasedInvoiceMinor = 0n;
  }
  let amountMinor = own.amountMinor;
  let releasedMinor = own.amountMinor - treasury.outstandingProgramMinor;
  if (releasedMinor < 0n) {
    amountMinor = treasury.outstandingProgramMinor;
    releasedMinor = 0n;
  }
  return {
    reservationId: own.id,
    invoiceId: own.invoiceId,
    invoiceAmountMinor,
    amountMinor,
    releasedInvoiceMinor,
    releasedMinor,
    status: releasedInvoiceMinor === 0n && releasedMinor === 0n ? 'ACTIVE' : 'PARTIALLY_RELEASED',
    deltaReservedMinor: treasury.outstandingProgramMinor - wasProgram,
  };
}

/** Whether treasury had applied the platform event that created `own` when it took the snapshot. */
function treasuryHasSeen(own: OwnReservation, snapshot: Snapshot, policy: ReconcilePolicy) {
  if (snapshot.platformWatermark !== null) return own.platformSeq <= snapshot.platformWatermark;
  return own.createdAt.getTime() <= snapshot.asOf.getTime() - policy.skewMs;
}

/**
 * Compares the program's reservations with a snapshot, case by case (PRD §8). "Treasury wins
 * wherever it has an opinion; where it is silent about something it should know, keep the larger
 * exposure."
 */
export function planReconciliation(
  programCurrency: string,
  ours: readonly OwnReservation[],
  snapshot: Snapshot,
  policy: ReconcilePolicy,
): ReconcilePlan {
  const byInvoice = new Map(ours.map((own) => [own.invoiceId, own]));
  const overwrites: Overwrite[] = [];
  const adoptions: Adoption[] = [];
  const drifts: Drift[] = [];
  const tolerated: Tolerated[] = [];
  let keptUnseen = 0;
  let delta = 0n;
  const listed = new Set<string>();

  for (const theirs of [...snapshot.reservations].sort((a, b) =>
    a.invoiceId < b.invoiceId ? -1 : 1,
  )) {
    listed.add(theirs.invoiceId);
    const own = byInvoice.get(theirs.invoiceId);
    const treasury = {
      invoiceMinor: theirs.outstandingInvoiceMinor,
      programMinor: theirs.outstandingProgramMinor,
    };
    if (own === undefined) {
      adoptions.push({
        invoiceId: theirs.invoiceId,
        invoiceCurrency: theirs.invoiceCurrency,
        invoiceAmountMinor: theirs.outstandingInvoiceMinor,
        amountMinor: theirs.outstandingProgramMinor,
        rate: impliedRate(
          theirs.invoiceCurrency,
          theirs.outstandingInvoiceMinor,
          programCurrency,
          theirs.outstandingProgramMinor,
        ),
      });
      drifts.push({ kind: 'ADOPTED', invoiceId: theirs.invoiceId, ours: null, treasury });
      delta += theirs.outstandingProgramMinor;
      continue;
    }
    const mine = outstandingOf(own);
    const programDiff = abs(mine.programMinor - theirs.outstandingProgramMinor);
    if (
      mine.invoiceMinor === theirs.outstandingInvoiceMinor &&
      programDiff <= policy.toleranceMinor
    ) {
      if (programDiff > 0n) {
        tolerated.push({ invoiceId: theirs.invoiceId, programDiffMinor: programDiff });
      }
      continue;
    }
    const overwrite = overwriteTo(own, theirs);
    overwrites.push(overwrite);
    delta += overwrite.deltaReservedMinor;
    drifts.push({ kind: 'ADJUSTED', invoiceId: theirs.invoiceId, ours: mine, treasury });
  }

  for (const own of [...ours].sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : 1))) {
    if (listed.has(own.invoiceId) || own.status === 'RELEASED') continue;
    const mine = outstandingOf(own);
    if (!treasuryHasSeen(own, snapshot, policy)) {
      keptUnseen += 1;
      continue;
    }
    if (policy.mode === 'HOLD') {
      drifts.push({ kind: 'HELD', invoiceId: own.invoiceId, ours: mine, treasury: null });
      continue;
    }
    overwrites.push({
      reservationId: own.id,
      invoiceId: own.invoiceId,
      invoiceAmountMinor: own.invoiceAmountMinor,
      amountMinor: own.amountMinor,
      releasedInvoiceMinor: own.invoiceAmountMinor,
      releasedMinor: own.amountMinor,
      status: 'RELEASED',
      deltaReservedMinor: -mine.programMinor,
    });
    delta -= mine.programMinor;
    drifts.push({ kind: 'RELEASED', invoiceId: own.invoiceId, ours: mine, treasury: null });
  }

  return {
    overwrites,
    adoptions,
    drifts,
    tolerated,
    keptUnseen,
    deltaReservedMinor: delta,
    usedFallback: snapshot.platformWatermark === null,
  };
}
