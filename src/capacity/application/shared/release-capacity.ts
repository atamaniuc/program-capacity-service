import {
  computeRelease,
  type Money,
  type Program,
  type Reservation,
} from '#src/capacity/domain/index.js';
import type { IdGenerator, TransactionScope } from '../ports/index.js';
import { rejected, succeeded, type Outcome } from './problem.js';
import { capacitySnapshot, moneyView, type ReleaseView } from './views.js';

export interface ReleaseCapacityInput {
  readonly tenantId: string;
  readonly programId: string;
  readonly reservationId: string;
  readonly releaseRef: string;
  readonly reason: 'REPAID' | 'CANCELLED';
  /** Repaid amount in invoice currency; omitted means the whole remainder. */
  readonly amount: Money | undefined;
  /** Fingerprint of the release (reason and amount); the release_ref scopes it to a reservation. */
  readonly fingerprint: string;
  /** Recorded in ledger and outbox rows (NFR-09). */
  readonly cause: { readonly type: string; readonly id: string; readonly actor: string };
  /**
   * Called right after the program lock. Returning false (a stale treasury message) discards the
   * claim and skips the release: the function then returns null.
   */
  readonly proceedWith?: ((program: Program) => boolean) | undefined;
}

/**
 * The release path of FR-03, shared by the HTTP release and the treasury repayment so both free
 * capacity the same way: release_ref row, then program lock, then reservation lock (PRD §8).
 * The caller has verified that the reservation belongs to the tenant and program.
 */
export async function releaseCapacity(
  tx: TransactionScope,
  ids: IdGenerator,
  input: ReleaseCapacityInput,
): Promise<Outcome<ReleaseView> | null> {
  const { tenantId, programId, reservationId, releaseRef, reason, fingerprint, cause } = input;

  const claimId = ids.next();
  const won = await tx.releases.claim({
    id: claimId,
    reservationId,
    releaseRef,
    fingerprint,
    reason,
  });
  if (!won) {
    const earlier = await tx.releases.find(reservationId, releaseRef);
    if (earlier === null || earlier.result === null) {
      throw new Error('release_ref was claimed but has no committed result');
    }
    return earlier.fingerprint === fingerprint
      ? (earlier.result as Outcome<ReleaseView>)
      : rejected(
          'release-ref-mismatch',
          `releaseRef ${releaseRef} was already used with a different amount or reason.`,
        );
  }

  const program = await tx.programs.lockForUpdate(tenantId, programId);
  if (program === null) throw new Error('program vanished under an existing reservation');
  if (input.proceedWith !== undefined && !input.proceedWith(program)) {
    await tx.releases.discard(claimId);
    return null;
  }
  const reservation = await tx.reservations.lockById(tenantId, programId, reservationId);
  if (reservation === null) throw new Error('reservation vanished under the program lock');

  const computed = computeRelease(
    {
      amountMinor: reservation.amountMinor,
      releasedMinor: reservation.releasedMinor,
      invoiceAmountMinor: reservation.invoiceAmount.minor,
      releasedInvoiceMinor: reservation.releasedInvoiceMinor,
    },
    input.amount?.minor,
  );
  if (!computed.ok) {
    // A refused release leaves no trace, so the same releaseRef can be retried with a fix.
    await tx.releases.discard(claimId);
    return rejected(
      'release-exceeds-remaining',
      'The release is above the remaining invoice amount.',
    );
  }
  const { invoiceMinor, programMinor, status } = computed.value;

  const updated = await tx.programs.release(tenantId, programId, programMinor);
  if (updated === null) throw new Error('invariant I1: reserved would drop below zero');
  const next: Reservation = {
    ...reservation,
    releasedMinor: reservation.releasedMinor + programMinor,
    releasedInvoiceMinor: reservation.releasedInvoiceMinor + invoiceMinor,
    status,
  };
  await tx.reservations.applyRelease({
    id: reservation.id,
    releasedMinor: next.releasedMinor,
    releasedInvoiceMinor: next.releasedInvoiceMinor,
    status,
  });
  await tx.ledger.append({
    tenantId,
    programId,
    reservationId,
    kind: 'RELEASE',
    deltaReservedMinor: -programMinor,
    deltaLimitMinor: 0n,
    limitAfter: updated.creditLimitMinor,
    reservedAfter: updated.reservedMinor,
    causeType: cause.type,
    causeId: cause.id,
    actor: cause.actor,
  });

  const view: ReleaseView = {
    releaseRef,
    reservationId,
    reservationStatus: status,
    reason,
    invoiceAmount: moneyView(invoiceMinor, reservation.invoiceAmount.currency),
    releasedAmount: moneyView(programMinor, program.currency),
    remainingAmount: moneyView(next.amountMinor - next.releasedMinor, program.currency),
    capacity: capacitySnapshot(updated),
  };
  const outcome = succeeded(200, view);
  await tx.releases.complete(claimId, { invoiceMinor, programMinor }, outcome);
  await tx.outbox.append({
    tenantId,
    programId,
    programSeq: updated.platformSeq,
    type: 'ReservationReleased',
    payload: { tenantId, programId, programSeq: updated.platformSeq, ...view },
  });
  return outcome;
}
