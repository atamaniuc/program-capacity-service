import { currencyScale, formatMoney, type Money } from '#src/capacity/domain/index.js';
import type { Clock, IdGenerator, TransactionScope, UnitOfWork } from '../../ports/index.js';
import { fingerprintOf } from '../../shared/fingerprint.js';
import { idempotently } from '../../shared/idempotent.js';
import { rejected, type Outcome } from '../../shared/problem.js';
import type { RequestContext } from '../../shared/request-context.js';
import { releaseCapacity } from '../../shared/release-capacity.js';
import type { ReleaseView } from '../../shared/views.js';

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
    return this.deps.uow.run(async (tx) => {
      // The invoice currency never changes, so a wrong amount currency is a validation error
      // decided before the key is claimed: the client fixes the request and reuses the key.
      const invoiceCurrency = await tx.reservations.invoiceCurrencyOf(
        command.tenantId,
        command.programId,
        command.reservationId,
      );
      if (
        invoiceCurrency !== null &&
        command.amount !== undefined &&
        command.amount.currency !== invoiceCurrency
      ) {
        return rejected<ReleaseView>(
          'validation-error',
          `amount.currency must be the invoice currency ${invoiceCurrency}.`,
        );
      }
      return idempotently(
        tx.idempotency,
        { tenantId: command.tenantId, key: command.idempotencyKey, fingerprint },
        () => this.release(tx, command, releaseFingerprint),
      );
    });
  }

  private async release(
    tx: TransactionScope,
    command: ReleaseReservationCommand,
    fingerprint: string,
  ): Promise<Outcome<ReleaseView>> {
    const { tenantId, programId, reservationId, releaseRef, reason } = command;

    // Ownership is checked with a plain read; the dedup row below needs an existing reservation.
    if ((await tx.reservations.invoiceCurrencyOf(tenantId, programId, reservationId)) === null) {
      return rejected('not-found', 'Reservation not found.');
    }

    const outcome = await releaseCapacity(tx, this.deps.ids, {
      tenantId,
      programId,
      reservationId,
      releaseRef,
      reason,
      amount: command.amount,
      fingerprint,
      cause: {
        type: 'http',
        id: command.idempotencyKey ?? command.requestId,
        actor: command.actor,
      },
    });
    if (outcome === null) throw new Error('an HTTP release has no stale guard');
    return outcome;
  }
}
