import {
  Metadata,
  Server,
  ServerCredentials,
  status,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import { BinaryWriter } from '@bufbuild/protobuf/wire';
import {
  CapacityServiceService,
  ReserveResult,
  type ReleaseRequest,
  type ReleaseResponse,
  type ReserveRequest,
  type ReserveResponse,
} from '@finverity/contracts/capacity/v1';

export type FakeReply<T> =
  | { readonly ok: T }
  | { readonly error: status; readonly reason?: string }
  /** The handler never answers: the caller's deadline fires. */
  | { readonly hang: true };

export interface RecordedCall<Req> {
  readonly request: Req;
  readonly metadata: Readonly<Record<string, string>>;
  /** The request exactly as it travelled, for byte-for-byte comparison across retries. */
  readonly bytes: Uint8Array;
}

export interface FakeCapacity {
  readonly target: string;
  readonly reserves: RecordedCall<ReserveRequest>[];
  readonly releases: RecordedCall<ReleaseRequest>[];
  onReserve: (call: RecordedCall<ReserveRequest>, index: number) => FakeReply<ReserveResponse>;
  onRelease: (call: RecordedCall<ReleaseRequest>, index: number) => FakeReply<ReleaseResponse>;
  close(): Promise<void>;
}

/** google.rpc.Status { details: [Any { ErrorInfo { reason } }] }, as capacity sends it (ADR 024). */
export function statusDetails(code: status, reason: string): Buffer {
  const info = new BinaryWriter().tag(1, 2).string(reason).tag(2, 2).string('capacity.finverity');
  const any = new BinaryWriter()
    .tag(1, 2)
    .string('type.googleapis.com/google.rpc.ErrorInfo')
    .tag(2, 2)
    .bytes(info.finish());
  const out = new BinaryWriter().tag(1, 0).int32(code).tag(3, 2).bytes(any.finish());
  return Buffer.from(out.finish());
}

export const created = (reservationId: string): FakeReply<ReserveResponse> => ({
  ok: {
    result: ReserveResult.RESERVE_RESULT_CREATED,
    reservation: reservationOf(reservationId),
    capacity: undefined,
  },
});

export const existing = (reservationId = 'res-other'): FakeReply<ReserveResponse> => ({
  ok: {
    result: ReserveResult.RESERVE_RESULT_EXISTING,
    reservation: reservationOf(reservationId),
    capacity: undefined,
  },
});

function reservationOf(reservationId: string): ReserveResponse['reservation'] {
  return {
    reservationId,
    invoiceId: '',
    status: 0,
    invoiceAmount: undefined,
    reservedAmount: undefined,
    releasedAmount: undefined,
    remainingAmount: undefined,
    fx: undefined,
    createdAt: '',
  };
}

export const released = (): FakeReply<ReleaseResponse> => ({
  ok: { reservation: undefined, capacity: undefined, release: undefined },
});

function metadataOf(metadata: Metadata): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(metadata.getMap())) out[key] = String(values);
  return out;
}

/** A capacity gRPC server generated from the same proto, answering as scripted. */
export async function startFakeCapacity(): Promise<FakeCapacity> {
  const server = new Server();
  const fake: FakeCapacity = {
    target: '',
    reserves: [],
    releases: [],
    onReserve: () => created('res-1'),
    onRelease: () => released(),
    close: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => {
          resolve();
        });
      }),
  };
  const answer =
    <Req, Res>(
      recorded: RecordedCall<Req>[],
      script: () => (call: RecordedCall<Req>, index: number) => FakeReply<Res>,
      encode: (request: Req) => Uint8Array,
    ) =>
    (call: ServerUnaryCall<Req, Res>, callback: sendUnaryData<Res>): void => {
      const entry: RecordedCall<Req> = {
        request: call.request,
        metadata: metadataOf(call.metadata),
        bytes: encode(call.request),
      };
      recorded.push(entry);
      const reply = script()(entry, recorded.length - 1);
      if ('hang' in reply) return;
      if ('ok' in reply) {
        callback(null, reply.ok);
        return;
      }
      const trailers = new Metadata();
      if (reply.reason !== undefined) {
        trailers.set('grpc-status-details-bin', statusDetails(reply.error, reply.reason));
      }
      callback({
        code: reply.error,
        details: reply.reason ?? '',
        metadata: trailers,
        name: 'Error',
        message: reply.reason ?? '',
      });
    };
  server.addService(CapacityServiceService, {
    reserve: answer<ReserveRequest, ReserveResponse>(
      fake.reserves,
      () => fake.onReserve,
      (r) => CapacityServiceService.reserve.requestSerialize(r),
    ),
    release: answer<ReleaseRequest, ReleaseResponse>(
      fake.releases,
      () => fake.onRelease,
      (r) => CapacityServiceService.release.requestSerialize(r),
    ),
    getAvailability: (_call: unknown, callback: sendUnaryData<never>) => {
      callback({
        code: status.UNIMPLEMENTED,
        details: 'not used by funding',
        name: 'Error',
        message: '',
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error === null) resolve(bound);
      else reject(error);
    });
  });
  return Object.assign(fake, { target: `127.0.0.1:${port.toString()}` });
}
