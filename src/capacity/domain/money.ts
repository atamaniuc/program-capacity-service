import { err, ok, type Result } from './result.js';

/** ISO 4217 minor-unit exponents of the supported currencies (PRD §6, money rule 1). */
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

/** An amount as integer minor units plus its currency (I8). */
export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export type MoneyError = 'unsupported-currency' | 'malformed-amount' | 'wrong-scale';

export function currencyScale(currency: CurrencyCode): number | undefined {
  return Object.hasOwn(CURRENCY_SCALES, currency) ? CURRENCY_SCALES[currency] : undefined;
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Parses a non-negative decimal string such as "1250.50". The number of fraction digits must be
 * exactly the currency's scale; signs, exponents, separators and surrounding spaces are refused.
 */
export function parseMoney(value: string, currency: CurrencyCode): Result<Money, MoneyError> {
  const scale = currencyScale(currency);
  if (scale === undefined) return err('unsupported-currency');
  const match = DECIMAL.exec(value);
  if (match === null) return err('malformed-amount');
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length !== scale) return err('wrong-scale');
  return ok({ minor: BigInt(whole + fraction), currency });
}

/** Formats minor units as a decimal string with exactly the currency's scale. */
export function formatMinor(minor: bigint, currency: CurrencyCode): string {
  const scale = currencyScale(currency);
  if (scale === undefined) throw new Error(`unsupported currency ${currency}`);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale === 0 ? '' : `.${fraction}`}`;
}

export function formatMoney(money: Money): string {
  return formatMinor(money.minor, money.currency);
}
