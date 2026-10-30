import {
  ReleaseReason,
  ReserveResult,
  ReservationStatus,
  type Capacity,
  type Money,
  type ReleaseRequest,
  type ReleaseResponse,
  type Reservation,
  type ReserveResponse,
} from './generated/finverity/capacity/v1/capacity_service.js';
import type {
  CapacitySnapshot,
  CapacityView,
  MoneyView,
  ReleaseView,
  ReservationView,
} from '#src/capacity/application/shared/views.js';

const money = (view: MoneyView): Money => ({ value: view.value, currencyCode: view.currency });

const STATUS: Record<string, ReservationStatus> = {
  ACTIVE: ReservationStatus.RESERVATION_STATUS_ACTIVE,
  PARTIALLY_RELEASED: ReservationStatus.RESERVATION_STATUS_PARTIALLY_RELEASED,
  RELEASED: ReservationStatus.RESERVATION_STATUS_RELEASED,
};

/** The snapshot echoed by a mutation carries four numbers; the rest of `Capacity` stays unset. */
function snapshot(programId: string, currency: string, view: CapacitySnapshot): Capacity {
  return {
    programId,
    currencyCode: currency,
    limit: { value: view.limit, currencyCode: currency },
    reserved: { value: view.reserved, currencyCode: currency },
    available: { value: view.available, currencyCode: currency },
    overLimitBy: undefined,
    utilization: '',
    version: view.version,
    treasurySeq: 0,
  };
}

/** `CREATED` for a stored 201, `EXISTING` for a 200 natural-key replay (ADR 024). */
export function reserveResponse(
  programId: string,
  status: 200 | 201,
  view: ReservationView,
): ReserveResponse {
  const reservation: Reservation = {
    reservationId: view.reservationId,
    invoiceId: view.invoiceId,
    status: STATUS[view.status] ?? ReservationStatus.RESERVATION_STATUS_UNSPECIFIED,
    invoiceAmount: money(view.invoiceAmount),
    reservedAmount: money(view.reservedAmount),
    releasedAmount: money(view.releasedAmount),
    remainingAmount: money(view.remainingAmount),
    fx: { rate: view.fx.rate, source: view.fx.source, asOf: view.fx.asOf },
    createdAt: view.createdAt,
  };
  return {
    result:
      status === 201 ? ReserveResult.RESERVE_RESULT_CREATED : ReserveResult.RESERVE_RESULT_EXISTING,
    reservation,
    capacity: snapshot(programId, view.reservedAmount.currency, view.capacity),
  };
}

/** `ReleaseResponse.release` is the REST `Release` body; `reservation` stays unset (ADR 024). */
export function releaseResponse(programId: string, view: ReleaseView): ReleaseResponse {
  return {
    reservation: undefined,
    capacity: snapshot(programId, view.remainingAmount.currency, view.capacity),
    release: {
      releaseRef: view.releaseRef,
      reservationId: view.reservationId,
      reservationStatus:
        STATUS[view.reservationStatus] ?? ReservationStatus.RESERVATION_STATUS_UNSPECIFIED,
      reason:
        view.reason === 'REPAID'
          ? ReleaseReason.RELEASE_REASON_REPAID
          : ReleaseReason.RELEASE_REASON_CANCELLED,
      repaidAmount: money(view.invoiceAmount),
      releasedAmount: money(view.releasedAmount),
      remainingAmount: money(view.remainingAmount),
    },
  };
}

export function capacityMessage(view: CapacityView): Capacity {
  const amount = (value: string): Money => ({ value, currencyCode: view.currency });
  return {
    programId: view.programId,
    currencyCode: view.currency,
    limit: amount(view.limit),
    reserved: amount(view.reserved),
    available: amount(view.available),
    overLimitBy: amount(view.overLimitBy),
    utilization: view.utilization,
    version: view.version,
    treasurySeq: view.treasurySeq,
  };
}

/** Plain object in the shape of the REST `ReleaseRequest` body, so the same zod schema parses it. */
export function releaseBody(request: ReleaseRequest): Record<string, unknown> {
  const reason =
    request.reason === ReleaseReason.RELEASE_REASON_REPAID
      ? 'REPAID'
      : request.reason === ReleaseReason.RELEASE_REASON_CANCELLED
        ? 'CANCELLED'
        : undefined;
  return {
    releaseRef: request.releaseRef,
    reason,
    ...(request.amount === undefined
      ? {}
      : { amount: { value: request.amount.value, currency: request.amount.currencyCode } }),
  };
}
