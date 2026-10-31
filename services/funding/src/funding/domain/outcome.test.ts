import { describe, expect, it } from 'vitest';
import {
  classifyDisburse,
  classifyRelease,
  classifyReserve,
  type GrpcCodeName,
} from './outcome.js';

describe('outcome classes (ADR 025)', () => {
  it('FS-01 Reserve: CREATED is success, EXISTING is not ours, definite codes fail, the rest is unknown', () => {
    expect(classifyReserve({ status: 'OK', result: 'CREATED', reservationId: 'r1' })).toEqual({
      kind: 'created',
      reservationId: 'r1',
    });
    expect(classifyReserve({ status: 'OK', result: 'EXISTING' })).toEqual({ kind: 'existing' });
    expect(
      classifyReserve({
        status: 'ERROR',
        code: 'FAILED_PRECONDITION',
        reason: 'fx-rate-unavailable',
      }),
    ).toEqual({ kind: 'failure', problem: 'fx-rate-unavailable' });
    const definite: GrpcCodeName[] = [
      'FAILED_PRECONDITION',
      'NOT_FOUND',
      'ALREADY_EXISTS',
      'INVALID_ARGUMENT',
    ];
    for (const code of definite) {
      expect(classifyReserve({ status: 'ERROR', code }).kind).toBe('failure');
    }
    const unknown: GrpcCodeName[] = [
      'UNAVAILABLE',
      'DEADLINE_EXCEEDED',
      'INTERNAL',
      'UNKNOWN',
      'ABORTED',
      'RESOURCE_EXHAUSTED',
      'UNAUTHENTICATED',
      // A refusal says nothing about an earlier attempt that may have landed (review M2).
      'PERMISSION_DENIED',
      'CANCELLED',
      'DATA_LOSS',
    ];
    for (const code of unknown) {
      expect(classifyReserve({ status: 'ERROR', code })).toEqual({ kind: 'unknown' });
    }
  });

  it('FS-11 Release: release-exceeds-remaining on a final release is success, other definite failures are not retried', () => {
    expect(classifyRelease({ status: 'OK' })).toEqual({ kind: 'released' });
    expect(
      classifyRelease({
        status: 'ERROR',
        code: 'FAILED_PRECONDITION',
        reason: 'release-exceeds-remaining',
      }),
    ).toEqual({ kind: 'released' });
    expect(classifyRelease({ status: 'ERROR', code: 'NOT_FOUND' })).toEqual({
      kind: 'failure',
      problem: 'not-found',
    });
    expect(
      classifyRelease({
        status: 'ERROR',
        code: 'FAILED_PRECONDITION',
        reason: 'release-ref-mismatch',
      }),
    ).toEqual({ kind: 'failure', problem: 'release-ref-mismatch' });
    expect(classifyRelease({ status: 'ERROR', code: 'UNAVAILABLE' })).toEqual({ kind: 'unknown' });
    expect(classifyRelease({ status: 'ERROR', code: 'PERMISSION_DENIED' })).toEqual({
      kind: 'failure',
      problem: 'permission-denied',
    });
  });

  it('FS-10 Disburse: only PAID and DECLINED are definite; timeouts, 5xx and unparseable answers are unknown', () => {
    expect(classifyDisburse({ kind: 'paid', paymentId: 'p1' })).toEqual({
      kind: 'paid',
      paymentId: 'p1',
    });
    expect(classifyDisburse({ kind: 'declined' })).toEqual({ kind: 'declined' });
    for (const kind of ['timeout', 'connection-lost', 'server-error', 'unparseable'] as const) {
      expect(classifyDisburse({ kind })).toEqual({ kind: 'unknown' });
    }
  });
});
