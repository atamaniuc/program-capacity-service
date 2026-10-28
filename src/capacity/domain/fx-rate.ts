import { currencyScale, type CurrencyCode, type Money } from './money.js';
import { err, ok, type Result } from './result.js';

/** Decimal places of a stored rate, matching NUMERIC(20,10). */
export const FX_RATE_DECIMALS = 10;
const RATE_ONE = 10n ** BigInt(FX_RATE_DECIMALS);

/** A rate from invoice currency to program currency as an integer scaled by 10^10. */
export interface FxRate {
  readonly scaled: bigint;
}

/** Same-currency invoices record this rate and skip conversion (money rule 6). */
export const IDENTITY_RATE: FxRate = { scaled: RATE_ONE };

const RATE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,10}))?$/;

export function parseFxRate(text: string): Result<FxRate, 'malformed-rate'> {
  const match = RATE.exec(text);
  if (match === null) return err('malformed-rate');
  const scaled = BigInt((match[1] ?? '') + (match[2] ?? '').padEnd(FX_RATE_DECIMALS, '0'));
  return scaled > 0n ? ok({ scaled }) : err('malformed-rate');
}

export function formatFxRate(rate: FxRate): string {
  const digits = rate.scaled.toString().padStart(FX_RATE_DECIMALS + 1, '0');
  const cut = digits.length - FX_RATE_DECIMALS;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Converts an invoice amount into the program currency, rounding **up** to the program's minor
 * unit (money rule 3): the platform never reserves less than the risk it takes. One integer
 * division, so there is a single rounding step.
 */
export function convertRoundingUp(
  invoice: Money,
  rate: FxRate,
  programCurrency: CurrencyCode,
): Result<Money, 'unsupported-currency'> {
  const invoiceScale = currencyScale(invoice.currency);
  const programScale = currencyScale(programCurrency);
  if (invoiceScale === undefined || programScale === undefined) return err('unsupported-currency');
  const numerator = invoice.minor * rate.scaled * 10n ** BigInt(programScale);
  const denominator = 10n ** BigInt(FX_RATE_DECIMALS + invoiceScale);
  return ok({ minor: ceilDiv(numerator, denominator), currency: programCurrency });
}
