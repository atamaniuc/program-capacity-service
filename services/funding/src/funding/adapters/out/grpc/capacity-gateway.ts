import { credentials, Metadata, status, type ServiceError } from '@grpc/grpc-js';
import { BinaryReader } from '@bufbuild/protobuf/wire';
import {
  CapacityServiceClient,
  ReleaseReason,
  ReserveResult,
  type ReleaseRequest,
  type ReleaseResponse,
  type ReserveRequest,
  type ReserveResponse,
} from '@finverity/contracts/capacity/v1';
import type {
  CapacityGateway,
  ReleaseCall,
  ReserveCall,
  TenantTokens,
} from '../../../application/saga-ports.js';
import {
  classifyRelease,
  classifyReserve,
  formatMoney,
  type GrpcCodeName,
  type ReleaseOutcome,
  type ReserveOutcome,
} from '../../../domain/index.js';

const CODE_NAMES: Readonly<Record<number, GrpcCodeName>> = {
  [status.OK]: 'OK',
  [status.CANCELLED]: 'CANCELLED',
  [status.UNKNOWN]: 'UNKNOWN',
  [status.INVALID_ARGUMENT]: 'INVALID_ARGUMENT',
  [status.DEADLINE_EXCEEDED]: 'DEADLINE_EXCEEDED',
  [status.NOT_FOUND]: 'NOT_FOUND',
  [status.ALREADY_EXISTS]: 'ALREADY_EXISTS',
  [status.PERMISSION_DENIED]: 'PERMISSION_DENIED',
  [status.RESOURCE_EXHAUSTED]: 'RESOURCE_EXHAUSTED',
  [status.FAILED_PRECONDITION]: 'FAILED_PRECONDITION',
  [status.ABORTED]: 'ABORTED',
  [status.OUT_OF_RANGE]: 'OUT_OF_RANGE',
  [status.UNIMPLEMENTED]: 'UNIMPLEMENTED',
  [status.INTERNAL]: 'INTERNAL',
  [status.UNAVAILABLE]: 'UNAVAILABLE',
  [status.DATA_LOSS]: 'DATA_LOSS',
  [status.UNAUTHENTICATED]: 'UNAUTHENTICATED',
};

/** `ErrorInfo.reason` of `grpc-status-details-bin` (google.rpc.Status { details: [Any] }). */
export function errorReasonOf(bytes: Uint8Array): string | undefined {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag === 26) {
      const any = new BinaryReader(reader.bytes());
      let url = '';
      let value: Uint8Array = new Uint8Array();
      while (any.pos < any.len) {
        const t = any.uint32();
        if (t === 10) url = any.string();
        else if (t === 18) value = any.bytes();
        else any.skip(t & 7);
      }
      if (url === 'type.googleapis.com/google.rpc.ErrorInfo') {
        const info = new BinaryReader(value);
        while (info.pos < info.len) {
          const t = info.uint32();
          if (t === 10) return info.string();
          info.skip(t & 7);
        }
      }
    } else reader.skip(tag & 7);
  }
  return undefined;
}

type Failure = { readonly status: 'ERROR'; readonly code: GrpcCodeName; readonly reason?: string };

export interface CapacityGatewayOptions {
  readonly target: string;
  readonly tokens: TenantTokens;
  /** Per-call deadline; above capacity's lock plus statement timeout (ADR 025). */
  readonly deadlineMs: number;
  readonly requestId?: () => string;
}

type Call<Res extends object> = (
  metadata: Metadata,
  options: { deadline: number },
  callback: (error: ServiceError | null, response?: Res) => void,
) => unknown;

/**
 * Capacity over gRPC: one JWT per tenant, the step's key in metadata, a deadline on every call.
 * A transport failure is an unknown outcome; only the codes of ADR 025's table are definite.
 */
export class GrpcCapacityGateway implements CapacityGateway {
  private readonly client: CapacityServiceClient;

  constructor(private readonly options: CapacityGatewayOptions) {
    this.client = new CapacityServiceClient(options.target, credentials.createInsecure());
  }

  close(): void {
    this.client.close();
  }

  async reserve(call: ReserveCall): Promise<ReserveOutcome> {
    // The body is a pure function of the persisted request: identical bytes on every attempt.
    const request: ReserveRequest = {
      programId: call.programId,
      invoiceId: call.invoiceId,
      amount: { value: formatMoney(call.amount), currencyCode: call.amount.currency },
    };
    const answer = await this.invoke<ReserveResponse>(
      call.tenantId,
      call.key,
      (metadata, options, callback) => this.client.reserve(request, metadata, options, callback),
    );
    if ('status' in answer) return classifyReserve(answer);
    const reservationId = answer.reservation?.reservationId ?? '';
    if (answer.result === ReserveResult.RESERVE_RESULT_EXISTING) {
      return classifyReserve({ status: 'OK', result: 'EXISTING' });
    }
    if (answer.result === ReserveResult.RESERVE_RESULT_CREATED && reservationId !== '') {
      return classifyReserve({ status: 'OK', result: 'CREATED', reservationId });
    }
    return { kind: 'unknown' };
  }

  async release(call: ReleaseCall): Promise<ReleaseOutcome> {
    const request: ReleaseRequest = {
      programId: call.programId,
      reservationId: call.reservationId,
      releaseRef: call.releaseRef,
      amount: undefined,
      reason: ReleaseReason.RELEASE_REASON_CANCELLED,
    };
    const answer = await this.invoke<ReleaseResponse>(
      call.tenantId,
      call.key,
      (metadata, options, callback) => this.client.release(request, metadata, options, callback),
    );
    return 'status' in answer ? classifyRelease(answer) : classifyRelease({ status: 'OK' });
  }

  /** One refresh on UNAUTHENTICATED (an expired or rotated token), then the answer stands. */
  private async invoke<Res extends object>(
    tenantId: string,
    key: string,
    call: Call<Res>,
  ): Promise<Res | Failure> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string;
      try {
        token = await this.options.tokens.tokenFor(tenantId);
      } catch {
        return { status: 'ERROR', code: 'UNAVAILABLE' };
      }
      const answer = await this.once<Res>(call, token, key);
      if ('status' in answer && answer.code === 'UNAUTHENTICATED' && attempt === 0) {
        this.options.tokens.invalidate(tenantId);
        continue;
      }
      return answer;
    }
    return { status: 'ERROR', code: 'UNAUTHENTICATED' };
  }

  private once<Res extends object>(
    call: Call<Res>,
    token: string,
    key: string,
  ): Promise<Res | Failure> {
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${token}`);
    metadata.set('idempotency-key', key);
    metadata.set('x-request-id', (this.options.requestId ?? crypto.randomUUID.bind(crypto))());
    return new Promise((resolve) => {
      call(metadata, { deadline: Date.now() + this.options.deadlineMs }, (error, response) => {
        if (error === null && response !== undefined) {
          resolve(response);
          return;
        }
        const raw = error?.metadata.get('grpc-status-details-bin')[0];
        const reason = raw instanceof Buffer ? errorReasonOf(raw) : undefined;
        const code = CODE_NAMES[error?.code ?? status.UNKNOWN] ?? 'UNKNOWN';
        resolve(
          reason === undefined ? { status: 'ERROR', code } : { status: 'ERROR', code, reason },
        );
      });
    });
  }
}
