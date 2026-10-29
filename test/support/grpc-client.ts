import { credentials, Metadata, status, type ServiceError } from '@grpc/grpc-js';
import { BinaryReader } from '@bufbuild/protobuf/wire';
import {
  CapacityServiceClient,
  type GetAvailabilityRequest,
  type GetAvailabilityResponse,
  type ReleaseRequest,
  type ReleaseResponse,
  type ReserveRequest,
  type ReserveResponse,
} from '#src/capacity/adapters/in/grpc/generated/finverity/capacity/v1/capacity_service.js';

export interface ErrorInfo {
  readonly reason: string;
  readonly domain: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type GrpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: status;
      readonly message: string;
      /** The ErrorInfo of `grpc-status-details-bin` (google.rpc.Status), when present. */
      readonly info: ErrorInfo | null;
      /** The google.rpc.Status code inside the details, when present. */
      readonly statusCode: number | null;
    };

export interface CallOptions {
  /** Bearer token; null sends no authorization metadata. */
  readonly token?: string | null;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
  readonly deadlineMs?: number;
  readonly extra?: Readonly<Record<string, string>>;
}

function readErrorInfo(bytes: Uint8Array): ErrorInfo {
  const reader = new BinaryReader(bytes);
  const info = { reason: '', domain: '', metadata: {} as Record<string, string> };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag === 10) info.reason = reader.string();
    else if (tag === 18) info.domain = reader.string();
    else if (tag === 26) {
      const entry = new BinaryReader(reader.bytes());
      let key = '';
      let value = '';
      while (entry.pos < entry.len) {
        const t = entry.uint32();
        if (t === 10) key = entry.string();
        else if (t === 18) value = entry.string();
        else entry.skip(t & 7);
      }
      info.metadata[key] = value;
    } else reader.skip(tag & 7);
  }
  return info;
}

/** Decodes `grpc-status-details-bin`: google.rpc.Status { code, message, details: [Any] }. */
export function decodeStatusDetails(bytes: Uint8Array): { code: number; info: ErrorInfo | null } {
  const reader = new BinaryReader(bytes);
  let code = 0;
  let info: ErrorInfo | null = null;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag === 8) code = reader.int32();
    else if (tag === 26) {
      const any = new BinaryReader(reader.bytes());
      let url = '';
      let value: Uint8Array = new Uint8Array();
      while (any.pos < any.len) {
        const t = any.uint32();
        if (t === 10) url = any.string();
        else if (t === 18) value = any.bytes();
        else any.skip(t & 7);
      }
      if (url === 'type.googleapis.com/google.rpc.ErrorInfo') info = readErrorInfo(value);
    } else reader.skip(tag & 7);
  }
  return { code, info };
}

export interface GrpcTestClient {
  reserve(request: ReserveRequest, options?: CallOptions): Promise<GrpcResult<ReserveResponse>>;
  release(request: ReleaseRequest, options?: CallOptions): Promise<GrpcResult<ReleaseResponse>>;
  getAvailability(
    request: GetAvailabilityRequest,
    options?: CallOptions,
  ): Promise<GrpcResult<GetAvailabilityResponse>>;
  close(): void;
}

/** The generated client with metadata and deadline handling, for tests. */
export function grpcTestClient(target: string): GrpcTestClient {
  const client = new CapacityServiceClient(target, credentials.createInsecure());
  const metadataOf = (options: CallOptions): Metadata => {
    const metadata = new Metadata();
    if (options.token !== undefined && options.token !== null) {
      metadata.set('authorization', `Bearer ${options.token}`);
    }
    if (options.idempotencyKey !== undefined)
      metadata.set('idempotency-key', options.idempotencyKey);
    if (options.requestId !== undefined) metadata.set('x-request-id', options.requestId);
    for (const [name, value] of Object.entries(options.extra ?? {})) metadata.set(name, value);
    return metadata;
  };
  const invoke = <Req, Res>(
    name: 'reserve' | 'release' | 'getAvailability',
    request: Req,
    options: CallOptions,
  ): Promise<GrpcResult<Res>> =>
    new Promise((resolve) => {
      const method = client[name].bind(client) as unknown as (
        request: Req,
        metadata: Metadata,
        options: { deadline: number },
        callback: (error: ServiceError | null, response?: Res) => void,
      ) => unknown;
      method(
        request,
        metadataOf(options),
        { deadline: Date.now() + (options.deadlineMs ?? 10_000) },
        (error, response) => {
          if (error === null && response !== undefined) {
            resolve({ ok: true, value: response });
            return;
          }
          const raw = error?.metadata.get('grpc-status-details-bin')[0];
          const details = raw instanceof Buffer ? decodeStatusDetails(raw) : null;
          resolve({
            ok: false,
            code: error?.code ?? status.UNKNOWN,
            message: error?.details ?? '',
            info: details?.info ?? null,
            statusCode: details?.code ?? null,
          });
        },
      );
    });
  return {
    reserve: (request, options = {}) => invoke('reserve', request, options),
    release: (request, options = {}) => invoke('release', request, options),
    getAvailability: (request, options = {}) => invoke('getAvailability', request, options),
    close: () => {
      client.close();
    },
  };
}
