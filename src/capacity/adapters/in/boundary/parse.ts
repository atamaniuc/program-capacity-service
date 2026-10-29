import type { ZodType } from 'zod';
import { parseMoney, type Money } from '#src/capacity/domain/index.js';
import { validationProblem } from './problem.js';

/** Validates a transport's plain input with a zod schema; the first issue becomes the detail. */
export function parse<T>(schema: ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw validationProblem(
      `${what}${path === '' ? '' : `.${path}`}: ${issue?.message ?? 'is invalid'}`,
    );
  }
  return result.data;
}

/** One money parser and scale check for both transports (ADR 004). */
export function money(amount: { value: string; currency: string }, field: string): Money {
  const parsed = parseMoney(amount.value, amount.currency);
  if (parsed.ok) return parsed.value;
  const reasons = {
    'unsupported-currency': `${field}.currency is not a supported ISO 4217 code`,
    'malformed-amount': `${field}.value must be an unsigned decimal string such as "1250.50"`,
    'wrong-scale': `${field}.value must have exactly the minor-unit digits of ${amount.currency}`,
    'amount-too-large': `${field}.value is too large`,
  } as const;
  throw validationProblem(reasons[parsed.error]);
}

/** Request id from the header or metadata, or a fresh one when absent or malformed. */
export function requestIdOf(supplied: unknown, generate: () => string): string {
  return typeof supplied === 'string' && /^[\x21-\x7e]{1,128}$/.test(supplied)
    ? supplied
    : generate();
}
