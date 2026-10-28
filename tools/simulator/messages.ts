import {
  messageKey,
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
} from '../../src/capacity/application/shared/treasury-messages.js';

/** A record the simulator publishes: topic, key and the exact JSON text of the value. */
export interface ProducedMessage {
  readonly topic: string;
  readonly key: string;
  readonly value: string;
}

export interface EnvelopeOptions {
  readonly tenantId: string;
  readonly programId: string;
  readonly seq: number;
  /** Defaults to a deterministic id from type, program and seq, so a re-send is a duplicate. */
  readonly messageId?: string;
  readonly occurredAt?: Date;
}

function envelope(type: string, options: EnvelopeOptions, payload: unknown): ProducedMessage {
  const { tenantId, programId, seq } = options;
  return {
    topic: TOPIC_CAPACITY,
    key: messageKey(tenantId, programId),
    value: JSON.stringify({
      messageId: options.messageId ?? `${type}:${tenantId}:${programId}:${seq}`,
      type,
      schemaVersion: 1,
      tenantId,
      programId,
      seq,
      occurredAt: (options.occurredAt ?? new Date()).toISOString(),
      payload,
    }),
  };
}

export interface Amount {
  readonly value: string;
  readonly currency: string;
}

export function limitSet(
  options: EnvelopeOptions,
  creditLimit: Amount,
  status?: 'ACTIVE' | 'SUSPENDED',
): ProducedMessage {
  return envelope('ProgramLimitSet', options, {
    creditLimit,
    ...(status === undefined ? {} : { status }),
  });
}

export function repayment(
  options: EnvelopeOptions,
  payload: { invoiceId: string; releaseRef: string; amount: Amount },
): ProducedMessage {
  return envelope('RepaymentReceived', options, payload);
}

export interface SnapshotReservationJson {
  readonly invoiceId: string;
  readonly outstandingInvoiceAmount: Amount;
  readonly outstandingReservedAmount: Amount;
}

export function snapshot(
  options: EnvelopeOptions,
  payload: {
    asOf: Date;
    creditLimit: Amount;
    platformWatermark?: number;
    reservations: readonly SnapshotReservationJson[];
  },
): ProducedMessage {
  return envelope('ProgramReconciled', options, {
    asOf: payload.asOf.toISOString(),
    creditLimit: payload.creditLimit,
    ...(payload.platformWatermark === undefined
      ? {}
      : { platformWatermark: payload.platformWatermark }),
    reservations: payload.reservations,
  });
}

/** FX rates are global: tenantId and programId carry "*", seq is a per-pair counter (ADR 007). */
export function fxRate(
  pair: { base: string; quote: string; rate: string; asOf: Date; source?: string },
  options: { seq?: number; messageId?: string; occurredAt?: Date } = {},
): ProducedMessage {
  const seq = options.seq ?? Math.floor(pair.asOf.getTime() / 1000);
  return {
    topic: TOPIC_FX_RATES,
    key: `${pair.base}${pair.quote}`,
    value: JSON.stringify({
      messageId:
        options.messageId ?? `FxRatePublished:${pair.base}${pair.quote}:${pair.asOf.toISOString()}`,
      type: 'FxRatePublished',
      schemaVersion: 1,
      tenantId: '*',
      programId: '*',
      seq,
      occurredAt: (options.occurredAt ?? new Date()).toISOString(),
      payload: {
        base: pair.base,
        quote: pair.quote,
        rate: pair.rate,
        asOf: pair.asOf.toISOString(),
        source: pair.source ?? 'treasury',
      },
    }),
  };
}
