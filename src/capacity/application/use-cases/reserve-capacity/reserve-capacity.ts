import {
  checkReserve,
  convertRoundingUp,
  currencyScale,
  formatMoney,
  hasSameTerms,
  IDENTITY_RATE,
  type Money,
  type Reservation,
} from '#src/capacity/domain/index.js';
import type { Clock, IdGenerator, TransactionScope, UnitOfWork } from '../../ports/index.js';
import { fingerprintOf } from '../../shared/fingerprint.js';
import { idempotently } from '../../shared/idempotent.js';
import { rejected, succeeded, type Outcome } from '../../shared/problem.js';
import type { RequestContext } from '../../shared/request-context.js';
import { moneyView, reservationView, type ReservationView } from '../../shared/views.js';

export const RESERVE_ROUTE = '/v1/programs/{programId}/reservations';

export interface ReserveCapacityCommand extends RequestContext {
  readonly programId: string;
  readonly invoiceId: string;
  readonly invoiceAmount: Money;
}

export interface ReserveCapacityDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly fxMaxAgeMs: number;
}

/** Reserve (PRD §8, CP-1): one transaction, dedup row → program row → reservation. */
export class ReserveCapacity {
  constructor(private readonly deps: ReserveCapacityDeps) {}

  async execute(command: ReserveCapacityCommand): Promise<Outcome<ReservationView>> {
    if (currencyScale(command.invoiceAmount.currency) === undefined) {
      return rejected('validation-error', 'amount.currency is not a supported currency.');
    }
    if (command.invoiceAmount.minor <= 0n) {
      return rejected('validation-error', 'amount must be greater than zero.');
    }
    const fingerprint = fingerprintOf({
      method: 'POST',
      route: RESERVE_ROUTE,
      programId: command.programId,
      body: {
        invoiceId: command.invoiceId,
        amount: {
          value: formatMoney(command.invoiceAmount),
          currency: command.invoiceAmount.currency,
        },
      },
    });
    return this.deps.uow.run((tx) =>
      idempotently(
        tx.idempotency,
        { tenantId: command.tenantId, key: command.idempotencyKey, fingerprint },
        () => this.reserve(tx, command),
      ),
    );
  }

  private async reserve(
    tx: TransactionScope,
    command: ReserveCapacityCommand,
  ): Promise<Outcome<ReservationView>> {
    const { tenantId, programId, invoiceId, invoiceAmount } = command;
    const { clock, ids, fxMaxAgeMs } = this.deps;

    const program = await tx.programs.lockForUpdate(tenantId, programId);
    if (program === null) return rejected('not-found', 'Program not found.');

    const existing = await tx.reservations.findByInvoice(tenantId, programId, invoiceId);
    if (existing !== null) {
      // A fully released reservation never replays: the invoice is closed (A7).
      return existing.status !== 'RELEASED' && hasSameTerms(existing, invoiceAmount)
        ? succeeded(200, reservationView(existing, program))
        : rejected(
            'reservation-conflict',
            `Invoice ${invoiceId} already has a reservation with different terms.`,
          );
    }

    // Suspended and over-limit programs refuse every amount, so they are decided before FX.
    const gate = checkReserve(program, 0n);
    if (!gate.ok) return rejected(gate.error, programRefusal(gate.error));

    const now = clock.now();
    let rate = IDENTITY_RATE;
    let fxSource = 'identity';
    let fxAt = now;
    if (invoiceAmount.currency !== program.currency) {
      const quote = await tx.fxRates.latest(
        invoiceAmount.currency,
        program.currency,
        new Date(now.getTime() - fxMaxAgeMs),
      );
      if (quote === null) {
        return rejected(
          'fx-rate-unavailable',
          `No recent ${invoiceAmount.currency}/${program.currency} rate is available.`,
        );
      }
      rate = quote.rate;
      fxSource = quote.source;
      fxAt = quote.asOf;
    }
    const converted = convertRoundingUp(invoiceAmount, rate, program.currency);
    if (!converted.ok) throw new Error(`program currency ${program.currency} has no known scale`);
    const amountMinor = converted.value.minor;

    const fits = checkReserve(program, amountMinor);
    if (!fits.ok) {
      return rejected(
        fits.error,
        `Reserving ${moneyView(amountMinor, program.currency).value} ${program.currency} needs more than the available capacity.`,
      );
    }

    const updated = await tx.programs.reserve(tenantId, programId, amountMinor);
    if (updated === null) throw new Error('invariant I2: guarded capacity update matched no row');

    const reservation: Reservation = {
      id: ids.next(),
      tenantId,
      programId,
      invoiceId,
      invoiceAmount,
      fx: { rate, source: fxSource, at: fxAt },
      amountMinor,
      releasedMinor: 0n,
      releasedInvoiceMinor: 0n,
      status: 'ACTIVE',
      origin: 'API',
      platformSeq: updated.platformSeq,
      createdAt: now,
    };
    await tx.reservations.insert(reservation);
    await tx.ledger.append({
      tenantId,
      programId,
      reservationId: reservation.id,
      kind: 'RESERVE',
      deltaReservedMinor: amountMinor,
      deltaLimitMinor: 0n,
      limitAfter: updated.creditLimitMinor,
      reservedAfter: updated.reservedMinor,
      causeType: 'http',
      causeId: command.idempotencyKey ?? command.requestId,
      actor: command.actor,
    });
    const view = reservationView(reservation, updated);
    await tx.outbox.append({
      tenantId,
      programId,
      programSeq: updated.platformSeq,
      type: 'ReservationCreated',
      payload: { tenantId, programId, programSeq: updated.platformSeq, ...view },
    });
    return succeeded(201, view);
  }
}

function programRefusal(
  reason: 'program-suspended' | 'program-over-limit' | 'insufficient-capacity',
): string {
  switch (reason) {
    case 'program-suspended':
      return 'The program is suspended; new reservations are blocked.';
    case 'program-over-limit':
      return 'Reserved exceeds the credit limit; new reservations are blocked until releases free capacity.';
    case 'insufficient-capacity':
      return 'The available capacity is below the requested amount.';
  }
}
