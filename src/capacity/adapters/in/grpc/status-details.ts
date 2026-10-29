import { BinaryWriter } from '@bufbuild/protobuf/wire';

/** Trailer that carries a serialized `google.rpc.Status` (gRPC error model, AIP-193). */
export const STATUS_DETAILS_KEY = 'grpc-status-details-bin';

/** `ErrorInfo.domain` (ADR 024): the REST `type` base, without the URL. */
export const ERROR_DOMAIN = 'capacity.finverity';

const ERROR_INFO_TYPE_URL = 'type.googleapis.com/google.rpc.ErrorInfo';

/**
 * `google.rpc.Status` with one `google.rpc.ErrorInfo` detail, encoded by hand: both messages are
 * tiny and stable, and a generated stub for them would add a dependency for forty lines.
 * Status { int32 code = 1; string message = 2; repeated Any details = 3 }
 * Any { string type_url = 1; bytes value = 2 }
 * ErrorInfo { string reason = 1; string domain = 2; map<string, string> metadata = 3 }
 */
export function encodeStatusDetails(input: {
  readonly code: number;
  readonly message: string;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string>>;
}): Buffer {
  const info = new BinaryWriter().uint32(10).string(input.reason).uint32(18).string(ERROR_DOMAIN);
  for (const [key, value] of Object.entries(input.metadata)) {
    info.uint32(26).fork().uint32(10).string(key).uint32(18).string(value).join();
  }
  const any = new BinaryWriter()
    .uint32(10)
    .string(ERROR_INFO_TYPE_URL)
    .uint32(18)
    .bytes(info.finish());
  const status = new BinaryWriter()
    .uint32(8)
    .int32(input.code)
    .uint32(18)
    .string(input.message)
    .uint32(26)
    .bytes(any.finish());
  return Buffer.from(status.finish());
}
