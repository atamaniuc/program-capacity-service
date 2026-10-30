/**
 * Outcome classes of ADR 025. Adapters turn a raw gRPC or HTTP answer into one of these with the
 * classifiers below; the transition table sees only the classes.
 */

/** Result of the Reserve call. */
export type ReserveOutcome =
  | { readonly kind: 'created'; readonly reservationId: string }
  /** The invoice already had a reservation with the same terms: not ours. */
  | { readonly kind: 'existing' }
  | { readonly kind: 'failure'; readonly problem: string }
  | { readonly kind: 'unknown' };

export type DisburseOutcome =
  | { readonly kind: 'paid'; readonly paymentId: string }
  | { readonly kind: 'declined' }
  | { readonly kind: 'unknown' };

export type ReleaseOutcome =
  | { readonly kind: 'released' }
  | { readonly kind: 'failure'; readonly problem: string }
  | { readonly kind: 'unknown' };

/** gRPC status names (capacity's ADR 024 mapping); the domain never imports a gRPC package. */
export type GrpcCodeName =
  | 'OK'
  | 'CANCELLED'
  | 'UNKNOWN'
  | 'INVALID_ARGUMENT'
  | 'DEADLINE_EXCEEDED'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'RESOURCE_EXHAUSTED'
  | 'FAILED_PRECONDITION'
  | 'ABORTED'
  | 'OUT_OF_RANGE'
  | 'UNIMPLEMENTED'
  | 'INTERNAL'
  | 'UNAVAILABLE'
  | 'DATA_LOSS'
  | 'UNAUTHENTICATED';

/** A Reserve answer: a response, or a failed call (`reason` is the `ErrorInfo.reason`, if any). */
export type ReserveAnswer =
  | { readonly status: 'OK'; readonly result: 'CREATED'; readonly reservationId: string }
  | { readonly status: 'OK'; readonly result: 'EXISTING' }
  | { readonly status: 'ERROR'; readonly code: GrpcCodeName; readonly reason?: string };

export type ReleaseAnswer =
  | { readonly status: 'OK' }
  | { readonly status: 'ERROR'; readonly code: GrpcCodeName; readonly reason?: string };

/** Codes that state, without doubt, that the call changed nothing (ADR 025 outcome table). */
const DEFINITE_FAILURE_CODES: ReadonlySet<GrpcCodeName> = new Set([
  'FAILED_PRECONDITION',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'INVALID_ARGUMENT',
  'PERMISSION_DENIED',
]);

function problemOf(code: GrpcCodeName, reason: string | undefined): string {
  return reason ?? code.toLowerCase().replaceAll('_', '-');
}

export function classifyReserve(answer: ReserveAnswer): ReserveOutcome {
  if (answer.status === 'OK') {
    return answer.result === 'CREATED'
      ? { kind: 'created', reservationId: answer.reservationId }
      : { kind: 'existing' };
  }
  return DEFINITE_FAILURE_CODES.has(answer.code)
    ? { kind: 'failure', problem: problemOf(answer.code, answer.reason) }
    : { kind: 'unknown' };
}

/**
 * `release-exceeds-remaining` on a final release can only mean the remainder is already zero:
 * a definite success. Every other definite failure is unexpected and never retried blindly.
 */
export function classifyRelease(answer: ReleaseAnswer): ReleaseOutcome {
  if (answer.status === 'OK') return { kind: 'released' };
  if (answer.reason === 'release-exceeds-remaining') return { kind: 'released' };
  return DEFINITE_FAILURE_CODES.has(answer.code)
    ? { kind: 'failure', problem: problemOf(answer.code, answer.reason) }
    : { kind: 'unknown' };
}

/** What the payment rail (or the transport to it) answered. */
export type RailAnswer =
  | { readonly kind: 'paid'; readonly paymentId: string }
  /** The rail states that no money moved. */
  | { readonly kind: 'declined' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'connection-lost' }
  | { readonly kind: 'server-error' }
  | { readonly kind: 'unparseable' };

export function classifyDisburse(answer: RailAnswer): DisburseOutcome {
  switch (answer.kind) {
    case 'paid':
      return { kind: 'paid', paymentId: answer.paymentId };
    case 'declined':
      return { kind: 'declined' };
    default:
      return { kind: 'unknown' };
  }
}
