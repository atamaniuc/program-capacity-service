import { PROBLEM_TYPES, type ProblemType } from '#src/capacity/application/shared/problem.js';

/** Problems the transports add on top of the business catalog. */
export type TransportProblemType =
  | ProblemType
  | 'unauthorized'
  | 'forbidden'
  | 'payload-too-large'
  | 'internal-error'
  | 'service-unavailable';

export const TRANSPORT_PROBLEM_TYPES: readonly TransportProblemType[] = [
  ...PROBLEM_TYPES,
  'unauthorized',
  'forbidden',
  'payload-too-large',
  'internal-error',
  'service-unavailable',
];

/** Numeric gRPC status codes (google.rpc.Code); named here so the boundary imports no gRPC library. */
export const GRPC_STATUS = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export type GrpcCode = (typeof GRPC_STATUS)[keyof typeof GRPC_STATUS];

export interface ProblemMapping {
  readonly title: string;
  readonly http: number;
  readonly grpc: GrpcCode;
}

/**
 * ADR 024: one table for both transports. The `Record` is exhaustive over every transport
 * problem type, so a new type does not compile until it has an HTTP status and a gRPC code.
 */
export const PROBLEM_MAP: Readonly<Record<TransportProblemType, ProblemMapping>> = {
  'insufficient-capacity': {
    title: 'Insufficient capacity',
    http: 422,
    grpc: GRPC_STATUS.FAILED_PRECONDITION,
  },
  'program-over-limit': {
    title: 'Program is over its limit',
    http: 422,
    grpc: GRPC_STATUS.FAILED_PRECONDITION,
  },
  'program-suspended': {
    title: 'Program is suspended',
    http: 422,
    grpc: GRPC_STATUS.FAILED_PRECONDITION,
  },
  // Stored under the Idempotency-Key (ADR 006): never UNAVAILABLE, a retry would only replay it.
  'fx-rate-unavailable': {
    title: 'FX rate unavailable',
    http: 422,
    grpc: GRPC_STATUS.FAILED_PRECONDITION,
  },
  'reservation-conflict': {
    title: 'Reservation conflict',
    http: 409,
    grpc: GRPC_STATUS.ALREADY_EXISTS,
  },
  'idempotency-key-mismatch': {
    title: 'Idempotency key reused with a different request',
    http: 422,
    grpc: GRPC_STATUS.FAILED_PRECONDITION,
  },
  'release-ref-mismatch': {
    title: 'Release reference reused with a different release',
    http: 422,
    grpc: GRPC_STATUS.FAILED_PRECONDITION,
  },
  'release-exceeds-remaining': {
    title: 'Release exceeds the remaining amount',
    http: 422,
    grpc: GRPC_STATUS.FAILED_PRECONDITION,
  },
  'validation-error': {
    title: 'Validation error',
    http: 400,
    grpc: GRPC_STATUS.INVALID_ARGUMENT,
  },
  'not-found': { title: 'Not found', http: 404, grpc: GRPC_STATUS.NOT_FOUND },
  unauthorized: { title: 'Unauthorized', http: 401, grpc: GRPC_STATUS.UNAUTHENTICATED },
  forbidden: { title: 'Forbidden', http: 403, grpc: GRPC_STATUS.PERMISSION_DENIED },
  'payload-too-large': {
    title: 'Payload too large',
    http: 413,
    grpc: GRPC_STATUS.RESOURCE_EXHAUSTED,
  },
  'internal-error': { title: 'Internal error', http: 500, grpc: GRPC_STATUS.INTERNAL },
  'service-unavailable': {
    title: 'Service unavailable',
    http: 503,
    grpc: GRPC_STATUS.UNAVAILABLE,
  },
};

/**
 * Business outcomes the use cases store under an `Idempotency-Key` and replay (ADR 006).
 * Validation and key-mismatch answers are never stored.
 */
export const STORED_PROBLEM_TYPES: readonly ProblemType[] = PROBLEM_TYPES.filter(
  (type) => type !== 'validation-error' && type !== 'idempotency-key-mismatch',
);

/** A problem raised at the boundary; each transport turns it into its own wire form. */
export class BoundaryProblem extends Error {
  constructor(
    readonly type: TransportProblemType,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export const unauthorizedProblem = (detail: string): BoundaryProblem =>
  new BoundaryProblem('unauthorized', detail);
export const forbiddenProblem = (detail: string): BoundaryProblem =>
  new BoundaryProblem('forbidden', detail);
export const validationProblem = (detail: string): BoundaryProblem =>
  new BoundaryProblem('validation-error', detail);
export const serviceUnavailableProblem = (detail: string): BoundaryProblem =>
  new BoundaryProblem('service-unavailable', detail);
