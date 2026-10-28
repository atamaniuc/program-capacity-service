import {
  computeRelease,
  currencyScale,
  formatMoney,
  type Money,
  type Reservation,
} from '#src/capacity/domain/index.js';
import type { Clock, IdGenerator, TransactionScope, UnitOfWork } from '../../ports/index.js';
import { fingerprintOf } from '../../shared/fingerprint.js';
import { idempotently } from '../../shared/idempotent.js';
import { rejected, succeeded, type Outcome } from '../../shared/problem.js';
import type { RequestContext } from '../../shared/request-context.js';
import { capacitySnapshot, moneyView, type ReleaseView } from '../../shared/views.js';

export const RELEASE_ROUTE = '/v1/programs/{programId}/reservations/{reservationId}/releases';

export type ReleaseReason = 'REPAID' | 'CANCELLED';

export interface ReleaseReservationCommand extends RequestContext {
  readonly programId: string;
  readonly reservationId: string;
  readonly releaseRef: string;
  /** Repaid amount in invoice currency; omitted means the whole remainder. */
  readonly amount?: Money | undefined;
  readonly reason: ReleaseReason;
}

export interface ReleaseReservationDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Release (PRD §8, CP-2): idempotency key and release_ref rows, then program, then reservation. */
export class ReleaseReservation {
  constructor(private readonly deps: ReleaseReservationDeps) {}

  async execute(command: ReleaseReservationCommand): Promise<Outcome<ReleaseView>> {
    if (command.amount !== undefined && currencyScale(command.amount.currency) === undefined) {
      return rejected('validation-error', 'amount.currency is not a supported currency.');
    }
    if (command.amount !== undefined && command.amount.minor <= 0n) {
      return rejected('validation-error', 'amount must be greater than zero.');
    }
    const body = {
      releaseRef: command.releaseRef,
      reason: command.reason,
      amount:
        command.amount === undefined
          ? null
          : { value: formatMoney(command.amount), currency: command.amount.currency },
    };
    const fingerprint = fingerprintOf({
      method: 'POST',
      route: RELEASE_ROUTE,
      programId: command.programId,
      reservationId: command.reservationId,
      body,
    });
    // The release_ref fingerprint ignores the route: the reservation already scopes it.
    const releaseFingerprint = fingerprintOf({ reason: command.reason, amount: body.amount });
    return this.deps.uow.run((tx) =>
      idempotently(
        tx.idempotency,
        { tenantId: command.tenantId, key: command.idempotencyKey, fingerprint },
        () => this.release(tx, command, releaseFingerprint),
      ),
    );
  }

  private async release(
    tx: TransactionScope,
    command: ReleaseReservationCommand,
    fingerprint: string,
  ): Promise<Outcome<ReleaseView>> {
    const { tenantId, programId, reservationId, releaseRef, reason } = command;

    // Ownership is checked with a plain read; the dedup row below needs an existing reservation.
    if (!(await tx.reservations.exists(tenantId, programId, reservationId))) {
      return rejected('not-found', 'Reservation not found.');
    }

    const claimId = this.deps.ids.next();
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
    const reservation = await tx.reservations.lockById(tenantId, programId, reservationId);
    if (reservation === null) throw new Error('reservation vanished under the program lock');

    const refuse = async (
      type: 'release-exceeds-remaining' | 'validation-error',
      detail: string,
    ) => {
      // A refused release leaves no trace, so the same releaseRef can be retried with a fix.
      await tx.releases.discard(claimId);
      return rejected<ReleaseView>(type, detail);
    };

    if (
      command.amount !== undefined &&
      command.amount.currency !== reservation.invoiceAmount.currency
    ) {
      return refuse(
        'validation-error',
        `amount.currency must be the invoice currency ${reservation.invoiceAmount.currency}.`,
      );
    }
    const computed = computeRelease(
      {
        amountMinor: reservation.amountMinor,
        releasedMinor: reservation.releasedMinor,
        invoiceAmountMinor: reservation.invoiceAmount.minor,
        releasedInvoiceMinor: reservation.releasedInvoiceMinor,
      },
      command.amount?.minor,
    );
    if (!computed.ok) {
      return refuse(
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
      causeType: 'http',
      causeId: command.idempotencyKey ?? command.requestId,
      actor: command.actor,
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
}
