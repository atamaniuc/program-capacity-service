import { Metadata, status, type ServerUnaryCall } from '@grpc/grpc-js';
import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import type { ReserveRequest } from './generated/finverity/capacity/v1/capacity_service.js';
import { createGrpcServer } from './server.js';

describe('GR-05 deadline check', () => {
  it('GR-05 answers DEADLINE_EXCEEDED and runs no use case when the deadline already passed', () => {
    const execute = vi.fn();
    const server = createGrpcServer({
      verifier: { authenticate: () => Promise.reject(new Error('unused')) },
      reserveCapacity: { execute } as unknown as ReserveCapacity,
      releaseReservation: {} as never,
      getCapacity: {} as never,
      registry: new Registry(),
      onError: () => undefined,
    });
    const call = {
      metadata: new Metadata(),
      request: { programId: 'p', invoiceId: 'i', amount: undefined } as ReserveRequest,
      getDeadline: () => new Date(Date.now() - 1000),
    } as unknown as ServerUnaryCall<ReserveRequest, never>;
    const callback = vi.fn();
    server.handlers.reserve(call, callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ code: status.DEADLINE_EXCEEDED });
    expect(execute).not.toHaveBeenCalled();
  });
});
