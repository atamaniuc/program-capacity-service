import { err, ok, type Result } from './result.js';

/** ISO 4217 minor-unit exponents of the supported currencies (same table as capacity). */
export const CURRENCY_SCALES: Readonly<Record<string, number>> = {
  AED: 2,
  AUD: 2,
  BHD: 3,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  INR: 2,
  JPY: 0,
  KWD: 3,
  OMR: 3,
  SAR: 2,
  SGD: 2,
  USD: 2,
};

/** An ISO 4217 alphabetic code. */
export type CurrencyCode = string;

/** An amount as integer minor units plus its currency. Never a floating-point number. */
export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export type MoneyError =
  'unsupported-currency' | 'malformed-amount' | 'wrong-scale' | 'amount-too-large' | 'not-positive';

/** Largest minor-unit amount a BIGINT column holds. */
export const MAX_MINOR = 9_223_372_036_854_775_807n;

export function currencyScale(currency: CurrencyCode): number | undefined {
  return Object.hasOwn(CURRENCY_SCALES, currency) ? CURRENCY_SCALES[currency] : undefined;
}

/** A positive amount in minor units; refuses unknown currencies and values a BIGINT cannot hold. */
export function money(minor: bigint, currency: CurrencyCode): Result<Money, MoneyError> {
  if (currencyScale(currency) === undefined) return err('unsupported-currency');
  if (minor <= 0n) return err('not-positive');
  if (minor > MAX_MINOR) return err('amount-too-large');
  return ok({ minor, currency });
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Parses a decimal string such as "1250.50"; the fraction has exactly the currency's scale. */
export function parseMoney(value: string, currency: CurrencyCode): Result<Money, MoneyError> {
  const scale = currencyScale(currency);
  if (scale === undefined) return err('unsupported-currency');
  const match = DECIMAL.exec(value);
  if (match === null) return err('malformed-amount');
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length !== scale) return err('wrong-scale');
  return money(BigInt(whole + fraction), currency);
}

/** Formats minor units as a decimal string with exactly the currency's scale. */
export function formatMoney(amount: Money): string {
  const scale = currencyScale(amount.currency);
  if (scale === undefined) throw new Error(`unsupported currency ${amount.currency}`);
  const digits = amount.minor.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  return scale === 0 ? whole : `${whole}.${digits.slice(digits.length - scale)}`;
}
