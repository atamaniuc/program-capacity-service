import type { ContractMessage } from './asyncapi.js';
import type {
  CapacityEventHeaders,
  CapacityEventType,
  ProgramCapacityChangedPayload,
  ReconciliationDriftDetectedPayload,
  ReservationCreatedPayload,
  ReservationReleasedPayload,
} from '#src/capacity/application/shared/capacity-events.js';
import type {
  FxRatePublished,
  ProgramLimitSet,
  ProgramReconciled,
  RepaymentReceived,
} from '#src/capacity/application/shared/treasury-messages.js';

/**
 * One story on program prg_grand_usd (USD) of bank-a, in AsyncAPI example form. A unit test
 * validates every example against the published schemas, so the docs never show a message the
 * service would reject or never send.
 */

export interface MessageExample {
  readonly name: string;
  readonly summary: string;
  readonly headers?: CapacityEventHeaders;
  readonly payload: object;
}

const TENANT = 'bank-a';
const PROGRAM = 'prg_grand_usd';
const RESERVATION = '01937a2e-5c4b-7d10-9a3f-2b6c8e1d4f70';

function event<T extends object>(
  type: CapacityEventType,
  messageId: string,
  seq: number,
  occurredAt: string,
  payload: T,
) {
  return {
    headers: {
      'event-id': messageId,
      'event-type': type,
      'schema-version': '1',
      'tenant-id': TENANT,
      'program-id': PROGRAM,
      'program-seq': String(seq),
      'content-type': 'application/json',
    } satisfies CapacityEventHeaders,
    payload: {
      messageId,
      type,
      schemaVersion: 1,
      tenantId: TENANT,
      programId: PROGRAM,
      seq,
      occurredAt,
      payload,
    },
  };
}

const reservationCreated: ReservationCreatedPayload = {
  tenantId: TENANT,
  programId: PROGRAM,
  programSeq: 42,
  reservationId: RESERVATION,
  invoiceId: 'INV-1003',
  status: 'ACTIVE',
  invoiceAmount: { value: '125000.00', currency: 'EUR' },
  reservedAmount: { value: '135000.00', currency: 'USD' },
  releasedAmount: { value: '0.00', currency: 'USD' },
  remainingAmount: { value: '135000.00', currency: 'USD' },
  fx: { rate: '1.0800000000', source: 'treasury', asOf: '2026-10-29T08:00:00.000Z' },
  createdAt: '2026-10-29T09:15:02.311Z',
  capacity: { limit: '10000000.00', reserved: '2545500.00', available: '7454500.00', version: 42 },
};

const reservationReleased: ReservationReleasedPayload = {
  tenantId: TENANT,
  programId: PROGRAM,
  programSeq: 43,
  releaseRef: 'repayment-2026-10-29-1',
  reservationId: RESERVATION,
  reservationStatus: 'PARTIALLY_RELEASED',
  reason: 'REPAID',
  invoiceAmount: { value: '50000.00', currency: 'EUR' },
  releasedAmount: { value: '54000.00', currency: 'USD' },
  remainingAmount: { value: '81000.00', currency: 'USD' },
  capacity: { limit: '10000000.00', reserved: '2491500.00', available: '7508500.00', version: 43 },
};

const limitSetChange: ProgramCapacityChangedPayload = {
  tenantId: TENANT,
  programId: PROGRAM,
  programSeq: 44,
  cause: 'limit-set',
  status: 'ACTIVE',
  capacity: {
    programId: PROGRAM,
    currency: 'USD',
    limit: '12000000.00',
    reserved: '2491500.00',
    available: '9508500.00',
    overLimitBy: '0.00',
    utilization: '0.2076',
    version: 44,
    treasurySeq: 7,
  },
};

const reconciliationChange: ProgramCapacityChangedPayload = {
  tenantId: TENANT,
  programId: PROGRAM,
  programSeq: 45,
  cause: 'reconciliation',
  snapshotSeq: 8,
  status: 'ACTIVE',
  capacity: {
    programId: PROGRAM,
    currency: 'USD',
    limit: '12500000.00',
    reserved: '2491500.00',
    available: '10008500.00',
    overLimitBy: '0.00',
    utilization: '0.1993',
    version: 45,
    treasurySeq: 8,
  },
};

const driftDetected: ReconciliationDriftDetectedPayload = {
  tenantId: TENANT,
  programId: PROGRAM,
  programSeq: 46,
  snapshotSeq: 8,
  asOf: '2026-10-29T12:00:00.000Z',
  mode: 'HOLD',
  driftCount: 1,
  truncated: false,
  drifts: [
    {
      kind: 'HELD',
      invoiceId: 'INV-0990',
      ours: { invoiceMinor: '1000000', programMinor: '1000000' },
      treasury: null,
    },
  ],
};

const treasuryEnvelope = (messageId: string, seq: number, occurredAt: string) => ({
  messageId,
  schemaVersion: 1 as const,
  tenantId: TENANT,
  programId: PROGRAM,
  seq,
  occurredAt,
});

const limitSet: ProgramLimitSet = {
  ...treasuryEnvelope('limit-bank-a-prg_grand_usd-7', 7, '2026-10-29T10:00:00.000Z'),
  type: 'ProgramLimitSet',
  payload: { creditLimit: { value: '12000000.00', currency: 'USD' }, status: 'ACTIVE' },
};

const repayment: RepaymentReceived = {
  ...treasuryEnvelope('repayment-bank-a-prg_grand_usd-9', 9, '2026-10-29T13:00:00.000Z'),
  type: 'RepaymentReceived',
  payload: {
    invoiceId: 'INV-1003',
    releaseRef: 'repayment-2026-10-29-2',
    amount: { value: '25000.00', currency: 'EUR' },
  },
};

const reconciled: ProgramReconciled = {
  ...treasuryEnvelope('snapshot-bank-a-prg_grand_usd-8', 8, '2026-10-29T12:00:05.000Z'),
  type: 'ProgramReconciled',
  payload: {
    asOf: '2026-10-29T12:00:00.000Z',
    creditLimit: { value: '12500000.00', currency: 'USD' },
    platformWatermark: 44,
    reservations: [
      {
        invoiceId: 'INV-1003',
        outstandingInvoiceAmount: { value: '75000.00', currency: 'EUR' },
        outstandingReservedAmount: { value: '81000.00', currency: 'USD' },
      },
    ],
  },
};

const fxRate: FxRatePublished = {
  messageId: 'fx-EURUSD-2026-10-29T08:00:00.000Z',
  type: 'FxRatePublished',
  schemaVersion: 1,
  tenantId: '*',
  programId: '*',
  seq: 1,
  occurredAt: '2026-10-29T08:00:00.000Z',
  payload: {
    base: 'EUR',
    quote: 'USD',
    rate: '1.0800000000',
    asOf: '2026-10-29T08:00:00.000Z',
    source: 'treasury',
  },
};

export const MESSAGE_EXAMPLES: Readonly<Record<ContractMessage, readonly MessageExample[]>> = {
  ProgramLimitSet: [{ name: 'raise-limit', summary: 'Limit raised to 12M USD', payload: limitSet }],
  RepaymentReceived: [
    { name: 'partial-repayment', summary: 'Part of INV-1003 repaid', payload: repayment },
  ],
  ProgramReconciled: [
    {
      name: 'snapshot',
      summary: 'Treasury applied platform events 1..44; one open reservation',
      payload: reconciled,
    },
  ],
  FxRatePublished: [{ name: 'eur-usd', summary: 'EUR to USD rate', payload: fxRate }],
  ReservationCreated: [
    {
      name: 'eur-invoice',
      summary: 'A EUR invoice reserved on a USD program, converted and rounded up',
      ...event(
        'ReservationCreated',
        '01937a2e-5c4c-7a21-8b40-6d2f9e0a1c35',
        42,
        '2026-10-29T09:15:02.311Z',
        reservationCreated,
      ),
    },
  ],
  ReservationReleased: [
    {
      name: 'partial-repayment',
      summary: 'Part of the invoice repaid; the rest stays reserved',
      ...event(
        'ReservationReleased',
        '01937b04-11aa-7c3e-9d52-7e8f0a1b2c3d',
        43,
        '2026-10-29T09:40:11.002Z',
        reservationReleased,
      ),
    },
  ],
  ProgramCapacityChanged: [
    {
      name: 'limit-set',
      summary: 'Treasury raised the limit',
      ...event(
        'ProgramCapacityChanged',
        '01937c6b-2f10-7b44-8c61-1a2b3c4d5e6f',
        44,
        '2026-10-29T10:00:00.420Z',
        limitSetChange,
      ),
    },
    {
      name: 'reconciliation',
      summary: 'A treasury snapshot changed the limit',
      ...event(
        'ProgramCapacityChanged',
        '01937d9a-8e21-7f05-a3b4-5c6d7e8f9a0b',
        45,
        '2026-10-29T12:00:05.730Z',
        reconciliationChange,
      ),
    },
  ],
  ReconciliationDriftDetected: [
    {
      name: 'held',
      summary: 'Treasury no longer lists a reservation it has seen; HOLD keeps it and reports it',
      ...event(
        'ReconciliationDriftDetected',
        '01937d9a-8e22-7a16-b4c5-6d7e8f9a0b1c',
        46,
        '2026-10-29T12:00:05.731Z',
        driftDetected,
      ),
    },
  ],
};
