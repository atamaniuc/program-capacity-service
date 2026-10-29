import { z } from 'zod';

/**
 * Outbound event contracts of `capacity.events.v1` (FR-13, PRD §9): the same envelope as the
 * treasury messages, four payloads. Use cases build payloads of these types, the relay wraps
 * them, and `contracts/` is generated from these schemas. The compiler catches a missing or
 * mistyped field; an extra one is caught by the strict schema in the Kafka contract test.
 */

export const CAPACITY_EVENTS_TOPIC = 'capacity.events.v1';

/** Keeps ReconciliationDriftDetected far below Kafka's 1 MB limit; the full list is in the logs. */
export const MAX_DRIFTS_IN_EVENT = 100;

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .meta({ description: 'Non-negative decimal string at the currency scale.', example: '1250.50' });

const money = z.object({
  value: decimal,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .meta({ description: 'ISO 4217 code.', example: 'USD' }),
});

const reservationStatus = z.enum(['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED']);
const releaseReason = z.enum(['REPAID', 'CANCELLED']);

/** Who and where: repeated inside the payload so a consumer can store it without the envelope. */
const subject = {
  tenantId: z.string().min(1).max(100),
  programId: z.string().min(1).max(100),
  programSeq: z
    .int()
    .min(1)
    .meta({ description: 'Gap-free per-program platform sequence; equals the envelope seq.' }),
};

const capacitySnapshot = z.object({
  limit: decimal,
  reserved: decimal,
  available: decimal,
  version: z.int().min(0).meta({ description: 'Program version after the change.' }),
});

const capacity = z.object({
  programId: z.string().min(1).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  limit: decimal,
  reserved: decimal,
  available: decimal.meta({ description: 'Never negative.' }),
  overLimitBy: decimal.meta({ description: 'Zero unless a limit cut left reserved above limit.' }),
  utilization: z
    .string()
    .regex(/^\d+\.\d{4}$/)
    .meta({ description: 'reserved / limit, four decimal places.', example: '0.7280' }),
  version: z.int().min(0),
  treasurySeq: z.int().min(0).meta({ description: 'Last treasury seq applied to the program.' }),
});

export const reservationCreatedPayloadSchema = z.object({
  ...subject,
  reservationId: z.uuid(),
  invoiceId: z.string().min(1),
  status: reservationStatus,
  invoiceAmount: money.meta({ description: 'In invoice currency.' }),
  reservedAmount: money.meta({ description: 'In program currency, rounded up.' }),
  releasedAmount: money.meta({ description: 'In program currency.' }),
  remainingAmount: money.meta({ description: 'In program currency.' }),
  fx: z.object({
    rate: z
      .string()
      .regex(/^\d+\.\d{10}$/)
      .meta({ description: 'Invoice to program currency, ten decimals.' }),
    source: z.string().min(1),
    asOf: z.iso.datetime(),
  }),
  createdAt: z.iso.datetime(),
  capacity: capacitySnapshot,
});

export const reservationReleasedPayloadSchema = z.object({
  ...subject,
  releaseRef: z.string().min(1).meta({
    description:
      'Reference of the release (a repayment or a cancellation); unique per reservation.',
  }),
  reservationId: z.uuid(),
  reservationStatus,
  reason: releaseReason,
  invoiceAmount: money.meta({ description: 'Repaid, in invoice currency.' }),
  releasedAmount: money.meta({ description: 'Capacity freed, in program currency.' }),
  remainingAmount: money.meta({ description: 'Still held, in program currency.' }),
  capacity: capacitySnapshot,
});

/** Added within v1 (2026-10-29), so optional: older events on the topic do not carry it. */
const programStatus = z.enum(['ACTIVE', 'SUSPENDED']).optional().meta({
  description:
    'Program status after the change; SUSPENDED refuses new reservations. Always sent now; absent in events published before 2026-10-29.',
});

export const programCapacityChangedPayloadSchema = z.discriminatedUnion('cause', [
  z.object({
    ...subject,
    cause: z.literal('limit-set').meta({
      description:
        'A ProgramLimitSet from treasury, sent for every applied one: also a suspend, a resume or the same limit again.',
    }),
    status: programStatus,
    capacity,
  }),
  z.object({
    ...subject,
    cause: z
      .literal('reconciliation')
      .meta({ description: 'A ProgramReconciled snapshot changed the limit or reservations.' }),
    snapshotSeq: z.int().min(1).meta({ description: 'Treasury seq of the snapshot.' }),
    status: programStatus,
    capacity,
  }),
]);

const driftAmounts = z
  .object({
    invoiceMinor: z.string().regex(/^\d+$/),
    programMinor: z.string().regex(/^\d+$/),
  })
  .nullable()
  .meta({
    description:
      'Outstanding amounts in minor units (integer strings) of the invoice and program currency; null when this side has no reservation.',
  });

export const reconciliationDriftDetectedPayloadSchema = z.object({
  ...subject,
  snapshotSeq: z.int().min(1),
  asOf: z.iso.datetime().meta({ description: 'asOf of the treasury snapshot.' }),
  mode: z.enum(['HOLD', 'RELEASE']).meta({ description: 'RECON_MODE the drift was handled in.' }),
  driftCount: z.int().min(1),
  truncated: z
    .boolean()
    .meta({ description: 'More than 100 drifts; the full list is in the logs.' }),
  drifts: z
    .array(
      z.object({
        kind: z.enum(['ADJUSTED', 'ADOPTED', 'HELD', 'RELEASED']),
        invoiceId: z.string().min(1),
        ours: driftAmounts,
        treasury: driftAmounts,
      }),
    )
    .max(MAX_DRIFTS_IN_EVENT),
});

const envelope = {
  messageId: z.uuid().meta({ description: 'Outbox row id; consumers deduplicate on it.' }),
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1).max(100),
  programId: z.string().min(1).max(100),
  seq: z
    .int()
    .min(1)
    .meta({ description: 'Gap-free per-program platform sequence (platform_seq).' }),
  occurredAt: z.iso.datetime(),
};

export const reservationCreatedSchema = z
  .object({
    ...envelope,
    type: z.literal('ReservationCreated'),
    payload: reservationCreatedPayloadSchema,
  })
  .meta({ id: 'ReservationCreated' });

export const reservationReleasedSchema = z
  .object({
    ...envelope,
    type: z.literal('ReservationReleased'),
    payload: reservationReleasedPayloadSchema,
  })
  .meta({ id: 'ReservationReleased' });

export const programCapacityChangedSchema = z
  .object({
    ...envelope,
    type: z.literal('ProgramCapacityChanged'),
    payload: programCapacityChangedPayloadSchema,
  })
  .meta({ id: 'ProgramCapacityChanged' });

export const reconciliationDriftDetectedSchema = z
  .object({
    ...envelope,
    type: z.literal('ReconciliationDriftDetected'),
    payload: reconciliationDriftDetectedPayloadSchema,
  })
  .meta({ id: 'ReconciliationDriftDetected' });

/** Kafka headers of every event; they repeat the envelope so a consumer can route without parsing. */
export const capacityEventHeadersSchema = z
  .object({
    'event-id': z.uuid(),
    'event-type': z.enum([
      'ReservationCreated',
      'ReservationReleased',
      'ProgramCapacityChanged',
      'ReconciliationDriftDetected',
    ]),
    'schema-version': z.literal('1'),
    'tenant-id': z.string().min(1),
    'program-id': z.string().min(1),
    'program-seq': z.string().regex(/^[1-9]\d*$/),
    'content-type': z.literal('application/json'),
  })
  .meta({ id: 'CapacityEventHeaders' });

export const capacityEventSchema = z.discriminatedUnion('type', [
  reservationCreatedSchema,
  reservationReleasedSchema,
  programCapacityChangedSchema,
  reconciliationDriftDetectedSchema,
]);

export type CapacityEvent = z.infer<typeof capacityEventSchema>;
/** The envelope fields every event shares (`type` and `payload` vary by event). */
export type CapacityEventEnvelope = Omit<CapacityEvent, 'type' | 'payload'>;
export type ReservationCreatedPayload = z.infer<typeof reservationCreatedPayloadSchema>;
export type ReservationReleasedPayload = z.infer<typeof reservationReleasedPayloadSchema>;
export type ProgramCapacityChangedPayload = z.infer<typeof programCapacityChangedPayloadSchema>;
export type ReconciliationDriftDetectedPayload = z.infer<
  typeof reconciliationDriftDetectedPayloadSchema
>;
export type CapacityEventHeaders = z.infer<typeof capacityEventHeadersSchema>;
export type CapacityEventType = CapacityEventHeaders['event-type'];
