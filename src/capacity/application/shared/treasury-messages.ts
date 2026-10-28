import { z } from 'zod';
import { currencyScale, parseFxRate, parseMoney, type Money } from '#src/capacity/domain/index.js';
import { PermanentError } from './treasury-errors.js';

/** Treasury message contracts (PRD §9): one envelope, four payloads, money as decimal strings. */

const currency = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');

export const moneySchema = z
  .object({ value: z.string(), currency })
  .refine((money) => parseMoney(money.value, money.currency).ok, {
    message: 'amount must be a non-negative decimal with the currency scale',
  })
  .meta({ id: 'Money' });

export type MoneyJson = z.infer<typeof moneySchema>;

/** Money from an already validated payload. */
export function moneyOf(json: MoneyJson): Money {
  const parsed = parseMoney(json.value, json.currency);
  if (!parsed.ok) throw new PermanentError('schema-invalid', `amount ${json.value} is invalid`);
  return parsed.value;
}

const envelope = {
  messageId: z.string().min(1).max(200),
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1).max(100),
  programId: z.string().min(1).max(100),
  /** Per-program treasury sequence; only grows (I7). */
  seq: z.int().min(1),
  occurredAt: z.iso.datetime(),
};

export const programLimitSetSchema = z
  .object({
    ...envelope,
    type: z.literal('ProgramLimitSet'),
    payload: z.object({
      creditLimit: moneySchema,
      status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
    }),
  })
  .meta({ id: 'ProgramLimitSet' });

export const repaymentReceivedSchema = z
  .object({
    ...envelope,
    type: z.literal('RepaymentReceived'),
    payload: z.object({
      invoiceId: z.string().min(1),
      /** Treasury's reference of this repayment; the release_ref of the release it causes. */
      releaseRef: z.string().min(1).max(200),
      amount: moneySchema,
    }),
  })
  .meta({ id: 'RepaymentReceived' });

export const programReconciledSchema = z
  .object({
    ...envelope,
    type: z.literal('ProgramReconciled'),
    payload: z.object({
      asOf: z.iso.datetime(),
      creditLimit: moneySchema,
      /** Contiguous prefix of platform events treasury has applied (PRD §8); absent: degraded. */
      platformWatermark: z.int().min(0).optional(),
      reservations: z.array(
        z.object({
          invoiceId: z.string().min(1),
          outstandingInvoiceAmount: moneySchema,
          outstandingReservedAmount: moneySchema,
        }),
      ),
    }),
  })
  .meta({ id: 'ProgramReconciled' });

export const fxRatePublishedSchema = z
  .object({
    ...envelope,
    type: z.literal('FxRatePublished'),
    payload: z.object({
      base: currency,
      quote: currency,
      /** Decimal string with at most ten fraction digits (NUMERIC(20,10)). */
      rate: z.string().refine((text) => parseFxRate(text).ok, {
        message: 'rate must be a positive decimal with at most 10 fraction digits',
      }),
      asOf: z.iso.datetime(),
      source: z.string().min(1),
    }),
  })
  .meta({ id: 'FxRatePublished' });

export const treasuryCapacityMessageSchema = z.discriminatedUnion('type', [
  programLimitSetSchema,
  repaymentReceivedSchema,
  programReconciledSchema,
]);

export type ProgramLimitSet = z.infer<typeof programLimitSetSchema>;
export type RepaymentReceived = z.infer<typeof repaymentReceivedSchema>;
export type ProgramReconciled = z.infer<typeof programReconciledSchema>;
export type FxRatePublished = z.infer<typeof fxRatePublishedSchema>;
export type TreasuryCapacityMessage = z.infer<typeof treasuryCapacityMessageSchema>;

export const TOPIC_CAPACITY = 'treasury.capacity.v1';
export const TOPIC_FX_RATES = 'treasury.fx-rates.v1';

/** The partition key of a capacity message; per-program order rides on it (PRD §8). */
export function messageKey(tenantId: string, programId: string): string {
  return `${tenantId}:${programId}`;
}

/** Cross-field checks a field schema cannot express; a violation parks the message. */
export function assertSupportedCurrency(code: string): void {
  if (currencyScale(code) === undefined) {
    throw new PermanentError('schema-invalid', `currency ${code} is not supported`);
  }
}
