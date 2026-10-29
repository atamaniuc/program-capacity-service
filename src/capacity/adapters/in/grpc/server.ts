import { randomUUID } from 'node:crypto';
import {
  Metadata,
  Server,
  ServerCredentials,
  ServerInterceptingCall,
  status,
  type handleUnaryCall,
  type ServerInterceptor,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import { context, propagation, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { Counter, Histogram, type Registry } from 'prom-client';
import type { Outcome } from '#src/capacity/application/shared/problem.js';
import type { GetCapacity } from '#src/capacity/application/use-cases/queries/get-capacity/get-capacity.js';
import type { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import type { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import type { Principal, Scope } from '../boundary/auth.js';
import { money, parse, requestIdOf } from '../boundary/parse.js';
import {
  BoundaryProblem,
  forbiddenProblem,
  isTransient,
  PROBLEM_MAP,
  type TransportProblemType,
} from '../boundary/problem.js';
import {
  IdempotencyKeyHeader,
  ProgramIdParam,
  ReservationParams,
  ReleaseRequest as ReleaseRequestSchema,
  ReserveRequest as ReserveRequestSchema,
} from '../boundary/schemas.js';
import {
  CapacityServiceService,
  type GetAvailabilityRequest,
  type GetAvailabilityResponse,
  type ReleaseRequest,
  type ReleaseResponse,
  type ReserveRequest,
  type ReserveResponse,
} from './generated/finverity/capacity/v1/capacity_service.js';
import { capacityMessage, releaseBody, releaseResponse, reserveResponse } from './mapping.js';
import { encodeStatusDetails, STATUS_DETAILS_KEY } from './status-details.js';

/** ADR 024: the maximum message size equals the REST body limit (Express default, 100 kB). */
export const MAX_MESSAGE_BYTES = 100 * 1024;

/** Scope per method path; a method missing here is denied (default-deny). */
export const METHOD_SCOPES: Readonly<Record<string, Scope>> = {
  [CapacityServiceService.reserve.path]: 'capacity:write',
  [CapacityServiceService.release.path]: 'capacity:write',
  [CapacityServiceService.getAvailability.path]: 'capacity:read',
};

export interface GrpcServerDeps {
  /** `JwtVerifier` in production; the same verifier as REST (ADR 011). */
  readonly verifier: { authenticate(header: string | undefined): Promise<Principal> };
  readonly reserveCapacity: ReserveCapacity;
  readonly releaseReservation: ReleaseReservation;
  readonly getCapacity: GetCapacity;
  readonly registry: Registry;
  /** Receives every failure that is not a client error; the client only sees `internal-error`. */
  readonly onError: (error: unknown) => void;
  /** Scope table override; production uses `METHOD_SCOPES`. */
  readonly scopes?: Readonly<Record<string, Scope>>;
}

export interface GrpcServer {
  /** Binds the port (0 picks a free one) and returns the bound port. */
  listen(port: number): Promise<number>;
  /** Readiness: rejects once the server stopped accepting calls. */
  check(): Promise<void>;
  /** Refuses new calls, lets in-flight calls finish, forces shutdown after `deadlineMs`. */
  drain(deadlineMs: number): Promise<void>;
}

interface Failure {
  readonly type: TransportProblemType;
  readonly detail: string;
}

function failureOf(error: unknown, onError: (error: unknown) => void): Failure {
  if (error instanceof BoundaryProblem) return { type: error.type, detail: error.detail };
  if (isTransient(error)) {
    return {
      type: 'service-unavailable',
      detail: 'The service could not complete the request in time; retry later.',
    };
  }
  onError(error);
  return { type: 'internal-error', detail: 'The request failed; retry later.' };
}

/** `grpc-status-details-bin` carries google.rpc.Status with an ErrorInfo (AIP-193, ADR 024). */
function statusOf(failure: Failure): { code: number; details: string; metadata: Metadata } {
  const code = PROBLEM_MAP[failure.type].grpc;
  const metadata = new Metadata();
  metadata.set(
    STATUS_DETAILS_KEY,
    encodeStatusDetails({
      code,
      message: failure.detail,
      reason: failure.type,
      metadata: { detail: failure.detail },
    }),
  );
  return { code, details: failure.detail, metadata };
}

const tracer = trace.getTracer('program-capacity-grpc');

const metadataGetter = {
  keys: (carrier: Metadata): string[] => Object.keys(carrier.getMap()),
  get: (carrier: Metadata, key: string): string | undefined => {
    const value = carrier.get(key)[0];
    return typeof value === 'string' ? value : undefined;
  },
};

function firstString(metadata: Metadata, key: string): string | undefined {
  const value = metadata.get(key)[0];
  return typeof value === 'string' ? value : undefined;
}

function shortName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function createGrpcServer(deps: GrpcServerDeps): GrpcServer {
  const scopes = deps.scopes ?? METHOD_SCOPES;
  const requests = new Counter({
    name: 'grpc_server_requests_total',
    help: 'gRPC calls by method and status code.',
    labelNames: ['method', 'code'],
    registers: [deps.registry],
  });
  const duration = new Histogram({
    name: 'grpc_server_duration_seconds',
    help: 'Duration of gRPC calls by method and status code.',
    labelNames: ['method', 'code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [deps.registry],
  });
  const record = (path: string, code: number, startedAt: bigint): void => {
    const labels = { method: shortName(path), code: status[code] ?? String(code) };
    requests.inc(labels);
    duration.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1e9);
  };

  /** Principals the interceptor authenticated, keyed by the metadata object the handler sees. */
  const principals = new WeakMap<Metadata, Principal>();

  const authenticate = async (path: string, metadata: Metadata): Promise<Principal> => {
    const principal = await deps.verifier.authenticate(firstString(metadata, 'authorization'));
    const required = scopes[path];
    if (required === undefined) throw forbiddenProblem('This method declares no required scope.');
    if (!principal.scopes.has(required)) {
      throw forbiddenProblem(`The token lacks the ${required} scope.`);
    }
    return principal;
  };

  /**
   * Authenticates before the request is handed on: no method answers anything but
   * UNAUTHENTICATED, UNAVAILABLE or PERMISSION_DENIED without a valid token and scope (S6). The
   * message is held back until then, so it reaches neither schema validation nor a use case.
   */
  const authInterceptor: ServerInterceptor = (methodDescriptor, call) => {
    const path = methodDescriptor.path;
    const startedAt = process.hrtime.bigint();
    let authorised: Promise<boolean> = Promise.resolve(false);
    return new ServerInterceptingCall(call, {
      start: (next) => {
        next({
          onReceiveMetadata: (metadata, forward) => {
            authorised = authenticate(path, metadata).then(
              (principal) => {
                principals.set(metadata, principal);
                return true;
              },
              (error: unknown) => {
                const response = statusOf(failureOf(error, deps.onError));
                record(path, response.code, startedAt);
                call.sendStatus(response);
                return false;
              },
            );
            forward(metadata);
          },
          onReceiveMessage: (message, forward) => {
            void authorised.then((ok) => {
              if (ok) forward(message);
            });
          },
          onReceiveHalfClose: (forward) => {
            void authorised.then((ok) => {
              if (ok) forward();
            });
          },
        });
      },
    });
  };

  /** One unary handler: deadline check, span, error mapping, RED metrics. */
  const unary = <Req, Res>(
    path: string,
    work: (
      request: Req,
      principal: Principal,
      requestId: string,
      metadata: Metadata,
    ) => Promise<Res>,
  ): handleUnaryCall<Req, Res> => {
    return (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>): void => {
      const startedAt = process.hrtime.bigint();
      const parent = propagation.extract(context.active(), call.metadata, metadataGetter);
      const span: Span = tracer.startSpan(
        path.slice(1),
        {
          attributes: {
            'rpc.system': 'grpc',
            'rpc.service': 'finverity.capacity.v1.CapacityService',
            'rpc.method': shortName(path),
          },
        },
        parent,
      );
      const fail = (failure: Failure): void => {
        const response = statusOf(failure);
        span.setAttribute('rpc.grpc.status_code', response.code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: failure.type });
        span.end();
        record(path, response.code, startedAt);
        callback(response);
      };
      const principal = principals.get(call.metadata);
      if (principal === undefined) {
        fail({ type: 'unauthorized', detail: 'A bearer token is required.' });
        return;
      }
      // The deadline is checked before the transaction opens; once it opens it is not abandoned.
      const remainingMs = Number(call.getDeadline()) - Date.now();
      if (remainingMs <= 0) {
        const code = status.DEADLINE_EXCEEDED;
        span.setAttribute('rpc.grpc.status_code', code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'deadline exceeded' });
        span.end();
        record(path, code, startedAt);
        callback({ code, details: 'The deadline passed before the call started.' });
        return;
      }
      const requestId = requestIdOf(firstString(call.metadata, 'x-request-id'), randomUUID);
      void context.with(trace.setSpan(parent, span), async () => {
        try {
          const response = await work(call.request, principal, requestId, call.metadata);
          span.setAttribute('rpc.grpc.status_code', status.OK);
          span.end();
          record(path, status.OK, startedAt);
          callback(null, response);
        } catch (error) {
          fail(failureOf(error, deps.onError));
        }
      });
    };
  };

  const idempotencyKeyOf = (metadata: Metadata): string | undefined =>
    parse(
      IdempotencyKeyHeader,
      { 'idempotency-key': firstString(metadata, 'idempotency-key') },
      'metadata',
    )['idempotency-key'];

  /** A business problem the use case stored or returned becomes the same boundary problem. */
  const unwrap = <V>(outcome: Outcome<V>): { status: 200 | 201; value: V } => {
    if (outcome.ok) return outcome;
    throw new BoundaryProblem(outcome.problem.type, outcome.problem.detail);
  };

  const implementation = {
    reserve: unary<ReserveRequest, ReserveResponse>(
      CapacityServiceService.reserve.path,
      async (request, principal, requestId, metadata) => {
        const { programId } = parse(ProgramIdParam, { programId: request.programId }, 'programId');
        const idempotencyKey = idempotencyKeyOf(metadata);
        const payload = parse(
          ReserveRequestSchema,
          {
            invoiceId: request.invoiceId,
            amount:
              request.amount === undefined
                ? undefined
                : { value: request.amount.value, currency: request.amount.currencyCode },
          },
          'body',
        );
        const { status: stored, value } = unwrap(
          await deps.reserveCapacity.execute({
            tenantId: principal.tenantId,
            actor: principal.actor,
            requestId,
            idempotencyKey,
            programId,
            invoiceId: payload.invoiceId,
            invoiceAmount: money(payload.amount, 'amount'),
          }),
        );
        return reserveResponse(programId, stored, value);
      },
    ),
    release: unary<ReleaseRequest, ReleaseResponse>(
      CapacityServiceService.release.path,
      async (request, principal, requestId, metadata) => {
        const { programId, reservationId } = parse(
          ReservationParams,
          { programId: request.programId, reservationId: request.reservationId },
          'request',
        );
        const idempotencyKey = idempotencyKeyOf(metadata);
        const payload = parse(ReleaseRequestSchema, releaseBody(request), 'body');
        const { value } = unwrap(
          await deps.releaseReservation.execute({
            tenantId: principal.tenantId,
            actor: principal.actor,
            requestId,
            idempotencyKey,
            programId,
            reservationId,
            releaseRef: payload.releaseRef,
            amount: payload.amount === undefined ? undefined : money(payload.amount, 'amount'),
            reason: payload.reason,
          }),
        );
        return releaseResponse(programId, value);
      },
    ),
    getAvailability: unary<GetAvailabilityRequest, GetAvailabilityResponse>(
      CapacityServiceService.getAvailability.path,
      async (request, principal) => {
        const { programId } = parse(ProgramIdParam, { programId: request.programId }, 'programId');
        const { value } = unwrap(
          await deps.getCapacity.execute({ tenantId: principal.tenantId, programId }),
        );
        return { capacity: capacityMessage(value) };
      },
    ),
  };

  const server = new Server({
    interceptors: [authInterceptor],
    'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
    'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
  });
  server.addService(CapacityServiceService, implementation);
  let state: 'new' | 'serving' | 'draining' = 'new';

  return {
    listen: (port) =>
      new Promise<number>((resolve, reject) => {
        server.bindAsync(`0.0.0.0:${port}`, ServerCredentials.createInsecure(), (error, bound) => {
          if (error !== null) {
            reject(error);
            return;
          }
          state = 'serving';
          resolve(bound);
        });
      }),
    check: () =>
      state === 'serving'
        ? Promise.resolve()
        : Promise.reject(new Error('gRPC server not serving')),
    drain: (deadlineMs) =>
      new Promise<void>((resolve) => {
        state = 'draining';
        const timer = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, deadlineMs);
        server.tryShutdown(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}
