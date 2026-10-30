import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAGA_CONFIG,
  applyOutcome,
  nextCommand,
  receiveFundingRequest,
  stepKey,
  compensationRef,
  type FundingRequest,
  type StepOutcome,
} from './index.js';

const base = (patch: Partial<FundingRequest> = {}): FundingRequest => {
  const created = receiveFundingRequest(
    {
      id: 'fr-1',
      tenantId: 't1',
      programId: 'p1',
      invoiceId: 'inv-1',
      amount: { minor: 100_000n, currency: 'USD' },
    },
    1_000,
  );
  if (!created.ok) throw new Error('fixture');
  return { ...created.value, ...patch };
};

const run = (request: FundingRequest, outcome: StepOutcome, now: number, random = 0.5) => {
  const result = applyOutcome(request, outcome, { now, config: DEFAULT_SAGA_CONFIG, random });
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.value;
};

describe('transition table (ADR 025)', () => {
  it('FS-01 RECEIVED + risk approved -> RESERVING with the reserve deadline', () => {
    const t = run(base(), { step: 'risk', decision: { approved: true } }, 5_000);
    expect(t.request.state).toBe('RESERVING');
    expect(t.request.reserveDeadlineAt).toBe(5_000 + DEFAULT_SAGA_CONFIG.reserveDeadlineMs);
    expect(t.event).toBeUndefined();
  });

  it('FS-04 RECEIVED + risk declined -> REJECTED risk-declined, outbox event, no reserve command', () => {
    const t = run(
      base(),
      { step: 'risk', decision: { approved: false, reason: 'risk-declined' } },
      5_000,
    );
    expect(t.request.state).toBe('REJECTED');
    expect(t.request.reason).toBe('risk-declined');
    expect(t.event).toBe('FundingRequestRejected');
    expect(nextCommand(t.request)).toBeUndefined();
  });

  it('FS-05 RESERVING definite failures reject with the problem type, EXISTING is not ours', () => {
    const reserving = base({ state: 'RESERVING', reserveDeadlineAt: 200_000 });
    for (const problem of [
      'insufficient-capacity',
      'fx-rate-unavailable',
      'reservation-conflict',
    ]) {
      const t = run(reserving, { step: 'reserve', outcome: { kind: 'failure', problem } }, 2_000);
      expect(t.request.state).toBe('REJECTED');
      expect(t.request.reason).toBe(problem);
      expect(t.event).toBe('FundingRequestRejected');
    }
    const existing = run(reserving, { step: 'reserve', outcome: { kind: 'existing' } }, 2_000);
    expect(existing.request.state).toBe('REJECTED');
    expect(existing.request.reason).toBe('invoice-already-reserved');
    expect(existing.request.reservationId).toBeUndefined();
  });

  it('FS-03 RESERVING + created -> DISBURSING, then paid -> COMPLETED with the payment id', () => {
    const reserving = base({ state: 'RESERVING', reserveDeadlineAt: 200_000 });
    const reserved = run(
      reserving,
      { step: 'reserve', outcome: { kind: 'created', reservationId: 'res-1' } },
      2_000,
    );
    expect(reserved.request.state).toBe('DISBURSING');
    expect(reserved.request.reservationId).toBe('res-1');
    expect(reserved.request.disburseDeadlineAt).toBe(
      2_000 + DEFAULT_SAGA_CONFIG.disburseDeadlineMs,
    );
    const paid = run(
      reserved.request,
      { step: 'disburse', outcome: { kind: 'paid', paymentId: 'pay-1' } },
      3_000,
    );
    expect(paid.request.state).toBe('COMPLETED');
    expect(paid.request.paymentId).toBe('pay-1');
    expect(paid.event).toBe('FundingRequestCompleted');
  });

  it('FS-06 DISBURSING + declined -> COMPENSATING; release by the compensation ref -> FAILED', () => {
    const disbursing = base({
      state: 'DISBURSING',
      reservationId: 'res-1',
      disburseDeadlineAt: 900_000,
    });
    const declined = run(disbursing, { step: 'disburse', outcome: { kind: 'declined' } }, 2_000);
    expect(declined.request.state).toBe('COMPENSATING');
    expect(nextCommand(declined.request)).toEqual({
      step: 'release',
      key: 'funding:fr-1:release',
      releaseRef: 'funding:fr-1:compensation',
      reservationId: 'res-1',
      reason: 'CANCELLED',
    });
    const released = run(
      declined.request,
      { step: 'release', outcome: { kind: 'released' } },
      3_000,
    );
    expect(released.request.state).toBe('FAILED');
    expect(released.event).toBe('FundingRequestFailed');
  });

  it('FS-10 DISBURSING unknown retries with lookup until the deadline, then NEEDS_ATTENTION, never compensation', () => {
    let request = base({ state: 'DISBURSING', reservationId: 'res-1', disburseDeadlineAt: 10_000 });
    expect(nextCommand(request)).toMatchObject({ step: 'disburse', lookupFirst: false });
    const first = run(request, { step: 'disburse', outcome: { kind: 'unknown' } }, 5_000);
    expect(first.request.state).toBe('DISBURSING');
    expect(first.request.attempts).toBe(1);
    expect(first.alert).toBe(false);
    request = first.request;
    expect(nextCommand(request)).toMatchObject({ step: 'disburse', lookupFirst: true });
    const parked = run(request, { step: 'disburse', outcome: { kind: 'unknown' } }, 10_000);
    expect(parked.request.state).toBe('NEEDS_ATTENTION');
    expect(parked.request.reason).toBe('disbursement-unknown');
    expect(parked.request.reservationId).toBe('res-1');
    expect(parked.event).toBe('FundingRequestNeedsAttention');
    expect(parked.alert).toBe(true);
    expect(nextCommand(parked.request)).toBeUndefined();
  });

  it('FS-09 RESERVING unknown past the reserve deadline -> COMPENSATING with an unknown reservation, resolved by a repeated Reserve', () => {
    const reserving = base({ state: 'RESERVING', reserveDeadlineAt: 10_000 });
    const early = run(reserving, { step: 'reserve', outcome: { kind: 'unknown' } }, 5_000);
    expect(early.request.state).toBe('RESERVING');
    const late = run(early.request, { step: 'reserve', outcome: { kind: 'unknown' } }, 10_000);
    expect(late.request.state).toBe('COMPENSATING');
    expect(late.request.reservationId).toBeUndefined();
    expect(late.request.resolutionDeadlineAt).toBe(
      10_000 + DEFAULT_SAGA_CONFIG.reserveResolutionLimitMs,
    );
    expect(nextCommand(late.request)).toEqual({
      step: 'reserve',
      key: 'funding:fr-1:reserve',
      resolving: true,
    });

    const created = run(
      late.request,
      { step: 'reserve', outcome: { kind: 'created', reservationId: 'res-7' } },
      11_000,
    );
    expect(created.request.state).toBe('COMPENSATING');
    expect(created.request.reservationId).toBe('res-7');
    expect(nextCommand(created.request)).toMatchObject({ step: 'release', reservationId: 'res-7' });

    const nothingHeld = run(
      late.request,
      { step: 'reserve', outcome: { kind: 'failure', problem: 'insufficient-capacity' } },
      11_000,
    );
    expect(nothingHeld.request.state).toBe('FAILED');
    expect(nothingHeld.event).toBe('FundingRequestFailed');
  });

  it('FS-09 an unknown reservation still unresolved at FUNDING_RESERVE_RESOLUTION_LIMIT -> NEEDS_ATTENTION', () => {
    const resolving = base({ state: 'COMPENSATING', resolutionDeadlineAt: 50_000 });
    const retrying = run(resolving, { step: 'reserve', outcome: { kind: 'unknown' } }, 49_999);
    expect(retrying.request.state).toBe('COMPENSATING');
    const parked = run(retrying.request, { step: 'reserve', outcome: { kind: 'unknown' } }, 50_000);
    expect(parked.request.state).toBe('NEEDS_ATTENTION');
    expect(parked.request.reason).toBe('reserve-unresolved');
    expect(parked.alert).toBe(true);
  });

  it('FS-11 compensation retries forever on unknown, with capped backoff, and parks only on a definite failure', () => {
    const compensating = base({
      state: 'COMPENSATING',
      reservationId: 'res-1',
      reason: 'payment-declined',
    });
    let request = compensating;
    for (let i = 0; i < 50; i += 1) {
      const t = run(
        request,
        { step: 'release', outcome: { kind: 'unknown' } },
        1_000 + i * 10_000_000,
        0.999,
      );
      expect(t.request.state).toBe('COMPENSATING');
      expect(t.request.nextAttemptAt - (1_000 + i * 10_000_000)).toBeLessThanOrEqual(60_000);
      request = t.request;
    }
    const parked = run(
      request,
      { step: 'release', outcome: { kind: 'failure', problem: 'not-found' } },
      9,
    );
    expect(parked.request.state).toBe('NEEDS_ATTENTION');
    expect(parked.request.reservationId).toBe('res-1');
    expect(parked.alert).toBe(true);
  });

  it('FS-01 refuses an outcome for another step, a terminal request and a parked request', () => {
    const ctx = { now: 1, config: DEFAULT_SAGA_CONFIG, random: 0 };
    expect(applyOutcome(base(), { step: 'release', outcome: { kind: 'released' } }, ctx)).toEqual({
      ok: false,
      error: 'step-mismatch',
    });
    expect(
      applyOutcome(
        base({ state: 'COMPLETED' }),
        { step: 'risk', decision: { approved: true } },
        ctx,
      ),
    ).toEqual({ ok: false, error: 'terminal' });
    expect(
      applyOutcome(
        base({ state: 'NEEDS_ATTENTION' }),
        { step: 'risk', decision: { approved: true } },
        ctx,
      ),
    ).toEqual({ ok: false, error: 'awaiting-operator' });
  });

  it('FS-01 step keys are derived from the request id and the step, not from the attempt', () => {
    expect(stepKey('fr-1', 'reserve')).toBe('funding:fr-1:reserve');
    expect(stepKey('fr-1', 'disburse')).toBe('funding:fr-1:disburse');
    expect(stepKey('fr-1', 'release')).toBe('funding:fr-1:release');
    expect(compensationRef('fr-1')).toBe('funding:fr-1:compensation');
    const reserving = base({ state: 'RESERVING', reserveDeadlineAt: 10_000_000 });
    const again = run(reserving, { step: 'reserve', outcome: { kind: 'unknown' } }, 2_000);
    expect(nextCommand(again.request)).toEqual(nextCommand(reserving));
  });
});
