import type { FxRate } from './fx-rate.js';
import type { Money } from './money.js';
import type { ReservationStatus } from './release.js';

export type ReservationOrigin = 'API' | 'TREASURY' | 'RECONCILIATION';

/** Capacity held for one invoice (PRD §6). */
export interface Reservation {
  readonly id: string;
  readonly tenantId: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly invoiceAmount: Money;
  readonly fx: { readonly rate: FxRate; readonly source: string; readonly at: Date };
  /** Reserved amount in program currency. */
  readonly amountMinor: bigint;
  readonly releasedMinor: bigint;
  readonly releasedInvoiceMinor: bigint;
  readonly status: ReservationStatus;
  readonly origin: ReservationOrigin;
  readonly platformSeq: number;
  readonly createdAt: Date;
}

/** Natural-key replay (FR-02): the same invoice amount and currency are the same terms. */
export function hasSameTerms(reservation: Reservation, invoiceAmount: Money): boolean {
  return (
    reservation.invoiceAmount.currency === invoiceAmount.currency &&
    reservation.invoiceAmount.minor === invoiceAmount.minor
  );
}

export function remainingMinor(reservation: Reservation): bigint {
  return reservation.amountMinor - reservation.releasedMinor;
}
