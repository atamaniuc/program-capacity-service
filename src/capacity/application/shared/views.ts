import {
  availableMinor,
  formatFxRate,
  formatMinor,
  overLimitByMinor,
  remainingMinor,
  utilization,
  type Program,
  type Reservation,
} from '#src/capacity/domain/index.js';

export interface MoneyView {
  readonly value: string;
  readonly currency: string;
}

export function moneyView(minor: bigint, currency: string): MoneyView {
  return { value: formatMinor(minor, currency), currency };
}

export interface CapacityView {
  readonly programId: string;
  readonly currency: string;
  readonly limit: string;
  readonly reserved: string;
  readonly available: string;
  readonly overLimitBy: string;
  readonly utilization: string;
  readonly version: number;
  readonly treasurySeq: number;
}

export function capacityView(program: Program): CapacityView {
  const money = (minor: bigint): string => formatMinor(minor, program.currency);
  return {
    programId: program.id,
    currency: program.currency,
    limit: money(program.creditLimitMinor),
    reserved: money(program.reservedMinor),
    available: money(availableMinor(program)),
    overLimitBy: money(overLimitByMinor(program)),
    utilization: utilization(program),
    version: program.version,
    treasurySeq: program.treasurySeq,
  };
}

/** The capacity numbers echoed in mutation responses. */
export interface CapacitySnapshot {
  readonly limit: string;
  readonly reserved: string;
  readonly available: string;
  readonly version: number;
}

export function capacitySnapshot(program: Program): CapacitySnapshot {
  const view = capacityView(program);
  return {
    limit: view.limit,
    reserved: view.reserved,
    available: view.available,
    version: view.version,
  };
}

export interface ReservationFields {
  readonly reservationId: string;
  readonly invoiceId: string;
  readonly status: string;
  readonly invoiceAmount: MoneyView;
  readonly reservedAmount: MoneyView;
  readonly releasedAmount: MoneyView;
  readonly remainingAmount: MoneyView;
  readonly fx: { readonly rate: string; readonly source: string; readonly asOf: string };
  readonly createdAt: string;
}

export function reservationFields(
  reservation: Reservation,
  programCurrency: string,
): ReservationFields {
  return {
    reservationId: reservation.id,
    invoiceId: reservation.invoiceId,
    status: reservation.status,
    invoiceAmount: moneyView(reservation.invoiceAmount.minor, reservation.invoiceAmount.currency),
    reservedAmount: moneyView(reservation.amountMinor, programCurrency),
    releasedAmount: moneyView(reservation.releasedMinor, programCurrency),
    remainingAmount: moneyView(remainingMinor(reservation), programCurrency),
    fx: {
      rate: formatFxRate(reservation.fx.rate),
      source: reservation.fx.source,
      asOf: reservation.fx.at.toISOString(),
    },
    createdAt: reservation.createdAt.toISOString(),
  };
}

export interface ReservationView extends ReservationFields {
  readonly capacity: CapacitySnapshot;
}

export function reservationView(reservation: Reservation, program: Program): ReservationView {
  return {
    ...reservationFields(reservation, program.currency),
    capacity: capacitySnapshot(program),
  };
}

export interface ReleaseView {
  readonly releaseRef: string;
  readonly reservationId: string;
  readonly reservationStatus: string;
  readonly reason: string;
  /** Repaid in invoice currency. */
  readonly invoiceAmount: MoneyView;
  /** Capacity freed in program currency. */
  readonly releasedAmount: MoneyView;
  /** What the reservation still holds, in program currency. */
  readonly remainingAmount: MoneyView;
  readonly capacity: CapacitySnapshot;
}
