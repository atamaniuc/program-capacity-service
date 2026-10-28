import { err, ok, type Result } from './result.js';

export type ReservationStatus = 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';

export interface ReleaseState {
  /** Reserved amount in program currency, fixed at reservation. */
  readonly amountMinor: bigint;
  readonly releasedMinor: bigint;
  /** Invoice amount in invoice currency. */
  readonly invoiceAmountMinor: bigint;
  readonly releasedInvoiceMinor: bigint;
}

export interface ReleaseComputation {
  /** Invoice-currency amount repaid by this release. */
  readonly invoiceMinor: bigint;
  /** Program-currency capacity freed by this release. */
  readonly programMinor: bigint;
  /** True when the release brings the released invoice amount to the invoice amount. */
  readonly completes: boolean;
  readonly status: ReservationStatus;
}

export type ReleaseError = 'exceeds-remaining' | 'non-positive';

/**
 * Money rule 5: a partial release of `repaid` frees floor(amount × repaid ÷ invoice amount) in
 * program currency; the release that completes the invoice takes the exact remainder, so all
 * releases of a reservation sum to `amountMinor`. `repaidInvoiceMinor` undefined means the whole
 * remaining invoice amount.
 */
export function computeRelease(
  state: ReleaseState,
  repaidInvoiceMinor: bigint | undefined,
): Result<ReleaseComputation, ReleaseError> {
  const remainingInvoice = state.invoiceAmountMinor - state.releasedInvoiceMinor;
  const repaid = repaidInvoiceMinor ?? remainingInvoice;
  if (repaid <= 0n)
    return err(repaidInvoiceMinor === undefined ? 'exceeds-remaining' : 'non-positive');
  if (repaid > remainingInvoice) return err('exceeds-remaining');
  const completes = repaid === remainingInvoice;
  const programMinor = completes
    ? state.amountMinor - state.releasedMinor
    : (state.amountMinor * repaid) / state.invoiceAmountMinor;
  return ok({
    invoiceMinor: repaid,
    programMinor,
    completes,
    status: completes ? 'RELEASED' : 'PARTIALLY_RELEASED',
  });
}
