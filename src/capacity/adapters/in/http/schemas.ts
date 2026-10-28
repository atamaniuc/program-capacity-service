import * as z from 'zod';

/** The only schema source of the REST contract: validation and `contracts/openapi.yaml` (ADR 015). */

export const Amount = z
  .object({
    value: z
      .string()
      .max(32)
      .meta({ description: 'Decimal string at the currency scale.', example: '1250.50' }),
    currency: z.string().length(3).meta({ description: 'ISO 4217 code.', example: 'USD' }),
  })
  .meta({ id: 'Amount' });

export const ReserveRequest = z
  .object({
    invoiceId: z.string().min(1).max(128).meta({ example: 'INV-1003' }),
    amount: Amount.meta({ description: 'Invoice amount in invoice currency; greater than zero.' }),
  })
  .strict()
  .meta({ id: 'ReserveRequest' });

export const ReleaseRequest = z
  .object({
    releaseRef: z.string().min(1).max(128).meta({ example: 'repayment-2026-10-28-1' }),
    amount: Amount.optional().meta({
      description: 'Repaid amount in invoice currency. Omitted: the whole remainder.',
    }),
    reason: z.enum(['REPAID', 'CANCELLED']),
  })
  .strict()
  .meta({ id: 'ReleaseRequest' });

export const ProgramIdParam = z.object({
  programId: z.string().min(1).max(128).meta({ example: 'prg_grand_usd' }),
});
export const ReservationParams = ProgramIdParam.extend({
  reservationId: z.string().meta({ description: 'UUID of the reservation.' }),
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
        'Makes the call idempotent per tenant. Keys and their stored responses are kept at least 24 hours. The first outcome is stored and replayed for the key, including business rejections such as 404, 409 and 422; validation, authentication and idempotency-key-mismatch errors are not stored.',
      example: '6f1c0e2a-9d7b-4c1e-8a55-0b3c2f1d7e90',
    }),
});

export const CapacitySnapshot = z
  .object({
    limit: z.string(),
    reserved: z.string(),
    available: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'CapacitySnapshot' });

const reservationFields = {
  reservationId: z.uuid(),
  invoiceId: z.string(),
  status: z.enum(['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED']),
  invoiceAmount: Amount,
  reservedAmount: Amount.meta({ description: 'In program currency, rounded up.' }),
  releasedAmount: Amount.meta({ description: 'In program currency.' }),
  remainingAmount: Amount.meta({ description: 'In program currency.' }),
  fx: z.object({
    rate: z.string().meta({ example: '1.0800000000' }),
    source: z.string(),
    asOf: z.iso.datetime(),
  }),
  createdAt: z.iso.datetime(),
};

export const ReservationResponse = z
  .object({ ...reservationFields, capacity: CapacitySnapshot })
  .meta({ id: 'Reservation' });

export const ReservationDetailResponse = z
  .object({
    ...reservationFields,
    releases: z.array(
      z.object({
        releaseRef: z.string(),
        reason: z.enum(['REPAID', 'CANCELLED']),
        invoiceAmount: Amount,
        releasedAmount: Amount,
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'ReservationDetail' });

export const ReleaseResponse = z
  .object({
    releaseRef: z.string(),
    reservationId: z.uuid(),
    reservationStatus: z.enum(['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED']),
    reason: z.enum(['REPAID', 'CANCELLED']),
    invoiceAmount: Amount.meta({ description: 'Repaid, in invoice currency.' }),
    releasedAmount: Amount.meta({ description: 'Capacity freed, in program currency.' }),
    remainingAmount: Amount.meta({ description: 'Still held, in program currency.' }),
    capacity: CapacitySnapshot,
  })
  .meta({ id: 'Release' });

export const CapacityResponse = z
  .object({
    programId: z.string(),
    currency: z.string(),
    limit: z.string(),
    reserved: z.string(),
    available: z.string().meta({ description: 'Never negative.' }),
    overLimitBy: z
      .string()
      .meta({ description: 'Zero unless a limit cut left reserved above limit.' }),
    utilization: z
      .string()
      .meta({ description: 'reserved / limit, four decimal places.', example: '0.7280' }),
    version: z.number().int(),
    treasurySeq: z.number().int(),
  })
  .meta({ id: 'Capacity' });

export const PROBLEM_TYPE_BASE = 'https://errors.capacity.example/';

export const ProblemResponse = z
  .object({
    type: z.string().meta({
      description: `${PROBLEM_TYPE_BASE}<problem>; clients branch on this, not on status.`,
      example: `${PROBLEM_TYPE_BASE}insufficient-capacity`,
    }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
  })
  .meta({ id: 'Problem' });
