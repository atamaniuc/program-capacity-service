import * as z from 'zod';

/** The only schema source of the REST contract: validation and `contracts/openapi.yaml` (ADR 015). */

export const PROBLEM_TYPE_BASE = 'https://errors.funding.example/';

export const Amount = z
  .object({
    value: z
      .string()
      .max(32)
      .meta({ description: 'Decimal string at the currency scale.', example: '1250.50' }),
    currency: z.string().length(3).meta({ description: 'ISO 4217 code.', example: 'USD' }),
  })
  .meta({ id: 'Amount' });

export const CreateFundingRequestBody = z
  .object({
    programId: z.string().min(1).max(128).meta({ example: 'prg_grand_usd' }),
    invoiceId: z.string().min(1).max(128).meta({ example: 'INV-1003' }),
    amount: Amount.meta({ description: 'Invoice amount to pay early; greater than zero.' }),
  })
  .strict()
  .meta({ id: 'CreateFundingRequest' });

export const FundingRequestParams = z.object({
  id: z.string().meta({ description: 'UUID of the funding request.' }),
});

export const IdempotencyKeyHeader = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/)
    .optional()
    .meta({
      description:
        'Makes the call idempotent per tenant. The first outcome is stored and replayed for the key, including business rejections; validation and authentication errors are not stored.',
      example: '6f1c0e2a-9d7b-4c1e-8a55-0b3c2f1d7e90',
    }),
});

export const FUNDING_STATES = [
  'RECEIVED',
  'RESERVING',
  'DISBURSING',
  'COMPENSATING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'NEEDS_ATTENTION',
] as const;

export const FundingRequestResponse = z
  .object({
    id: z.string(),
    programId: z.string(),
    invoiceId: z.string(),
    amount: Amount,
    state: z.enum(FUNDING_STATES),
    reason: z.string().nullable(),
    reservationId: z.string().nullable(),
    paymentId: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'FundingRequest' });

export const ProblemResponse = z
  .object({
    type: z.string().meta({
      description: `${PROBLEM_TYPE_BASE}<problem>; clients branch on this, not on status.`,
      example: `${PROBLEM_TYPE_BASE}funding-request-conflict`,
    }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
  })
  .meta({ id: 'Problem' });
