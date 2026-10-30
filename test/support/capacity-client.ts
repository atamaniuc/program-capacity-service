import { status } from '@grpc/grpc-js';
import {
  ReleaseReason,
  ReservationStatus,
  ReserveResult,
  type Money as WireMoney,
} from '@finverity/contracts/capacity/v1';
import type { TestApp } from './app.js';
import { grpcTestClient, type CallOptions, type GrpcTestClient } from './grpc-client.js';

/**
 * One transport-neutral view of the capacity API, so an acceptance case is written once and run
 * over REST and over gRPC (lane 0006, GR-03). Both transports are normalised to the same shapes:
 * money as `{ value, currency }`, problems as the REST problem type slug (`ErrorInfo.reason` on
 * gRPC), and the REST `invoiceAmount` of a release as `repaidAmount` (the proto name).
 */
export type Transport = 'http' | 'grpc';

export interface Money {
  readonly value: string;
  readonly currency: string;
}

export interface ReservationOut {
  readonly reservationId: string;
  readonly invoiceId: string;
  readonly status: 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';
  readonly invoiceAmount: Money;
  readonly reservedAmount: Money;
  readonly releasedAmount: Money;
  readonly remainingAmount: Money;
}

export interface Snapshot {
  readonly limit: string;
  readonly reserved: string;
  readonly available: string;
  readonly version: number;
}

export interface ReserveOut {
  /** `true` for a stored or fresh creation (201, CREATED); `false` for a natural-key replay (200, EXISTING). */
  readonly created: boolean;
  readonly reservation: ReservationOut;
  readonly snapshot: Snapshot;
}

export interface ReleaseOut {
  readonly releaseRef: string;
  readonly reservationId: string;
  readonly reservationStatus: ReservationOut['status'];
  readonly reason: 'REPAID' | 'CANCELLED';
  /** Repaid, in invoice currency. */
  readonly repaidAmount: Money;
  /** Capacity freed, in program currency. */
  readonly releasedAmount: Money;
  readonly remainingAmount: Money;
  readonly snapshot: Snapshot;
}

export interface CapacityOut {
  readonly programId: string;
  readonly currency: string;
  readonly limit: string;
  readonly reserved: string;
  readonly available: string;
  readonly overLimitBy: string;
  readonly utilization: string;
  readonly version: number;
  readonly treasurySeq: number;
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** The problem type slug (REST `type` suffix, gRPC `ErrorInfo.reason`). */
      readonly problem: string;
      /** The transport's own status: HTTP status or gRPC code. */
      readonly code: number;
    };

export interface Auth {
  /** Bearer token; `null` sends none; omitted uses the app's default token. */
  readonly token?: string | null;
  readonly key?: string;
}

export interface ReserveInput extends Auth {
  readonly programId: string;
  readonly invoiceId: string;
  readonly amount: Money;
}

export interface ReleaseInput extends Auth {
  readonly programId: string;
  readonly reservationId: string;
  readonly releaseRef: string;
  readonly reason: 'REPAID' | 'CANCELLED';
  readonly amount?: Money;
}

export interface CapacityClient {
  readonly transport: Transport;
  reserve(input: ReserveInput): Promise<Outcome<ReserveOut>>;
  release(input: ReleaseInput): Promise<Outcome<ReleaseOut>>;
  getCapacity(input: Auth & { programId: string }): Promise<Outcome<CapacityOut>>;
  close(): void;
}

const PROBLEM_BASE = 'https://errors.capacity.example/';

const REST_STATUS: Record<string, ReservationOut['status']> = {
  ACTIVE: 'ACTIVE',
  PARTIALLY_RELEASED: 'PARTIALLY_RELEASED',
  RELEASED: 'RELEASED',
};

const WIRE_STATUS: Partial<Record<ReservationStatus, ReservationOut['status']>> = {
  [ReservationStatus.RESERVATION_STATUS_ACTIVE]: 'ACTIVE',
  [ReservationStatus.RESERVATION_STATUS_PARTIALLY_RELEASED]: 'PARTIALLY_RELEASED',
  [ReservationStatus.RESERVATION_STATUS_RELEASED]: 'RELEASED',
};

function required<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`response has no ${what}`);
  return value;
}

const wireMoney = (money: WireMoney | undefined, what: string): Money => {
  const value = required(money, what);
  return { value: value.value, currency: value.currencyCode };
};

const wireStatus = (value: ReservationStatus): ReservationOut['status'] =>
  required(WIRE_STATUS[value], 'reservation status');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed JSON bodies */
export function httpCapacityClient(app: TestApp): CapacityClient {
  const fail = (response: { status: number; body: Json }): Outcome<never> => ({
    ok: false,
    problem: String(response.body?.type ?? '').replace(PROBLEM_BASE, ''),
    code: response.status,
  });
  const options = (input: Auth) => ({
    ...(input.token === undefined ? {} : { token: input.token }),
    ...(input.key === undefined ? {} : { headers: { 'idempotency-key': input.key } }),
  });
  const reservation = (body: Json): ReservationOut => ({
    reservationId: body.reservationId,
    invoiceId: body.invoiceId,
    status: required(REST_STATUS[body.status as string], 'status'),
    invoiceAmount: body.invoiceAmount,
    reservedAmount: body.reservedAmount,
    releasedAmount: body.releasedAmount,
    remainingAmount: body.remainingAmount,
  });
  const snapshot = (body: Json): Snapshot => ({
    limit: body.limit,
    reserved: body.reserved,
    available: body.available,
    version: body.version,
  });
  return {
    transport: 'http',
    reserve: async (input) => {
      const response = await app.request('POST', `/v1/programs/${input.programId}/reservations`, {
        ...options(input),
        body: { invoiceId: input.invoiceId, amount: input.amount },
      });
      if (response.status !== 200 && response.status !== 201) return fail(response);
      return {
        ok: true,
        value: {
          created: response.status === 201,
          reservation: reservation(response.body),
          snapshot: snapshot(response.body.capacity),
        },
      };
    },
    release: async (input) => {
      const response = await app.request(
        'POST',
        `/v1/programs/${input.programId}/reservations/${input.reservationId}/releases`,
        {
          ...options(input),
          body: {
            releaseRef: input.releaseRef,
            reason: input.reason,
            ...(input.amount === undefined ? {} : { amount: input.amount }),
          },
        },
      );
      if (response.status !== 200) return fail(response);
      const body = response.body;
      return {
        ok: true,
        value: {
          releaseRef: body.releaseRef,
          reservationId: body.reservationId,
          reservationStatus: required(REST_STATUS[body.reservationStatus as string], 'status'),
          reason: body.reason,
          repaidAmount: body.invoiceAmount,
          releasedAmount: body.releasedAmount,
          remainingAmount: body.remainingAmount,
          snapshot: snapshot(body.capacity),
        },
      };
    },
    getCapacity: async (input) => {
      const response = await app.request('GET', `/v1/programs/${input.programId}/capacity`, {
        ...options(input),
      });
      if (response.status !== 200) return fail(response);
      const b = response.body;
      return {
        ok: true,
        value: {
          programId: b.programId,
          currency: b.currency,
          limit: b.limit,
          reserved: b.reserved,
          available: b.available,
          overLimitBy: b.overLimitBy,
          utilization: b.utilization,
          version: b.version,
          treasurySeq: b.treasurySeq,
        },
      };
    },
    close: () => undefined,
  };
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

export function grpcCapacityClient(app: TestApp): CapacityClient {
  const client: GrpcTestClient = grpcTestClient(app.grpcTarget);
  const callOptions = async (input: Auth): Promise<CallOptions> => ({
    token: input.token === undefined ? await app.token() : input.token,
    ...(input.key === undefined ? {} : { idempotencyKey: input.key }),
  });
  const fail = (result: { code: status; info: { reason: string } | null }): Outcome<never> => ({
    ok: false,
    problem: result.info?.reason ?? '',
    code: result.code,
  });
  const snapshot = (value: {
    limit?: WireMoney | undefined;
    reserved?: WireMoney | undefined;
    available?: WireMoney | undefined;
    version: number;
  }): Snapshot => ({
    limit: wireMoney(value.limit, 'limit').value,
    reserved: wireMoney(value.reserved, 'reserved').value,
    available: wireMoney(value.available, 'available').value,
    version: value.version,
  });
  return {
    transport: 'grpc',
    reserve: async (input) => {
      const result = await client.reserve(
        {
          programId: input.programId,
          invoiceId: input.invoiceId,
          amount: { value: input.amount.value, currencyCode: input.amount.currency },
        },
        await callOptions(input),
      );
      if (!result.ok) return fail(result);
      const r = required(result.value.reservation, 'reservation');
      return {
        ok: true,
        value: {
          created: result.value.result === ReserveResult.RESERVE_RESULT_CREATED,
          reservation: {
            reservationId: r.reservationId,
            invoiceId: r.invoiceId,
            status: wireStatus(r.status),
            invoiceAmount: wireMoney(r.invoiceAmount, 'invoiceAmount'),
            reservedAmount: wireMoney(r.reservedAmount, 'reservedAmount'),
            releasedAmount: wireMoney(r.releasedAmount, 'releasedAmount'),
            remainingAmount: wireMoney(r.remainingAmount, 'remainingAmount'),
          },
          snapshot: snapshot(required(result.value.capacity, 'capacity')),
        },
      };
    },
    release: async (input) => {
      const result = await client.release(
        {
          programId: input.programId,
          reservationId: input.reservationId,
          releaseRef: input.releaseRef,
          reason:
            input.reason === 'REPAID'
              ? ReleaseReason.RELEASE_REASON_REPAID
              : ReleaseReason.RELEASE_REASON_CANCELLED,
          amount:
            input.amount === undefined
              ? undefined
              : { value: input.amount.value, currencyCode: input.amount.currency },
        },
        await callOptions(input),
      );
      if (!result.ok) return fail(result);
      const r = required(result.value.release, 'release');
      return {
        ok: true,
        value: {
          releaseRef: r.releaseRef,
          reservationId: r.reservationId,
          reservationStatus: wireStatus(r.reservationStatus),
          reason: r.reason === ReleaseReason.RELEASE_REASON_REPAID ? 'REPAID' : 'CANCELLED',
          repaidAmount: wireMoney(r.repaidAmount, 'repaidAmount'),
          releasedAmount: wireMoney(r.releasedAmount, 'releasedAmount'),
          remainingAmount: wireMoney(r.remainingAmount, 'remainingAmount'),
          snapshot: snapshot(required(result.value.capacity, 'capacity')),
        },
      };
    },
    getCapacity: async (input) => {
      const result = await client.getAvailability(
        { programId: input.programId },
        await callOptions(input),
      );
      if (!result.ok) return fail(result);
      const c = required(result.value.capacity, 'capacity');
      return {
        ok: true,
        value: {
          programId: c.programId,
          currency: c.currencyCode,
          limit: wireMoney(c.limit, 'limit').value,
          reserved: wireMoney(c.reserved, 'reserved').value,
          available: wireMoney(c.available, 'available').value,
          overLimitBy: wireMoney(c.overLimitBy, 'overLimitBy').value,
          utilization: c.utilization,
          version: c.version,
          treasurySeq: c.treasurySeq,
        },
      };
    },
    close: () => {
      client.close();
    },
  };
}
