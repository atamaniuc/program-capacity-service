import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { created, existing, released, startFakeCapacity } from '../support/fake-capacity.js';
import type { Claim, SagaStore } from '#src/funding/application/saga-ports.js';
import type { Transition } from '#src/funding/domain/index.js';
import { startSagaWorld, type SagaWorld } from '../support/saga-world.js';

let world: SagaWorld;

beforeAll(async () => {
  world = await startSagaWorld();
});

afterAll(async () => {
  await world.close();
});

describe('saga driver: rejection paths', () => {
  it('FS-04 an invoice above the risk limit is REJECTED risk-declined and capacity gets no call', async () => {
    const id = await world.submit({ invoiceId: 'inv-risk', value: '1000000.01' });
    const driver = world.driver();
    await world.drain(driver);

    const row = await world.row(id);
    expect(row['state']).toBe('REJECTED');
    expect(row['reason']).toBe('risk-declined');
    expect(world.capacity.reserves.filter((c) => c.request.invoiceId === 'inv-risk')).toHaveLength(
      0,
    );
    expect(world.rail.calls.filter((c) => c.invoiceId === 'inv-risk')).toHaveLength(0);
    expect(await world.attempts(id)).toEqual([
      { step: 'risk', outcome_class: 'failure', state_after: 'REJECTED' },
    ]);
    expect(await world.outbox(id)).toEqual(['FundingRequestReceived', 'FundingRequestRejected']);
  });

  it('FS-04 an unlisted currency is declined the same way', async () => {
    const id = await world.submit({ invoiceId: 'inv-aed', value: '10.00', currency: 'AED' });
    await world.drain(world.driver());
    expect((await world.row(id))['reason']).toBe('risk-declined');
  });

  it("FS-05 insufficient-capacity REJECTS with capacity's reason: no disbursement, no release", async () => {
    world.capacity.onReserve = () => ({
      error: status.FAILED_PRECONDITION,
      reason: 'insufficient-capacity',
    });
    const id = await world.submit({ invoiceId: 'inv-full' });
    await world.drain(world.driver());

    const row = await world.row(id);
    expect(row['state']).toBe('REJECTED');
    expect(row['reason']).toBe('insufficient-capacity');
    expect(world.rail.calls.filter((c) => c.invoiceId === 'inv-full')).toHaveLength(0);
    expect(world.capacity.releases).toHaveLength(0);
    expect((await world.attempts(id)).map((a) => `${a.step}:${a.outcome_class}`)).toEqual([
      'risk:success',
      'reserve:failure',
    ]);
  });

  it('FS-05 EXISTING (reserved by someone else) is REJECTED invoice-already-reserved and releases nothing', async () => {
    world.capacity.onReserve = () => existing('res-of-a-rest-client');
    const id = await world.submit({ invoiceId: 'inv-taken' });
    await world.drain(world.driver());

    const row = await world.row(id);
    expect(row['state']).toBe('REJECTED');
    expect(row['reason']).toBe('invoice-already-reserved');
    expect(row['reservation_id']).toBeNull();
    expect(world.capacity.releases).toHaveLength(0);
    expect(world.rail.calls.filter((c) => c.invoiceId === 'inv-taken')).toHaveLength(0);
  });

  it('FS-05 a conflicting reservation (ALREADY_EXISTS) and a stale FX rate are REJECTED, never retried', async () => {
    const before = world.capacity.reserves.length;
    world.capacity.onReserve = () => ({
      error: status.ALREADY_EXISTS,
      reason: 'reservation-conflict',
    });
    const conflict = await world.submit({ invoiceId: 'inv-conflict' });
    await world.drain(world.driver());
    expect((await world.row(conflict))['reason']).toBe('reservation-conflict');

    world.capacity.onReserve = () => ({
      error: status.FAILED_PRECONDITION,
      reason: 'fx-rate-unavailable',
    });
    const fx = await world.submit({ invoiceId: 'inv-fx' });
    await world.drain(world.driver());
    expect((await world.row(fx))['reason']).toBe('fx-rate-unavailable');
    expect(world.capacity.reserves.length - before).toBe(2);
  });

  it('FS-03 the happy path with fakes: RECEIVED -> RESERVING -> DISBURSING -> COMPLETED, outbox Received and Completed', async () => {
    world.capacity.onReserve = () => created('res-happy');
    world.rail.onDisburse = () => ({ kind: 'paid', paymentId: 'pay-happy' });
    const id = await world.submit({ invoiceId: 'inv-happy' });
    await world.drain(world.driver());

    const row = await world.row(id);
    expect(row['state']).toBe('COMPLETED');
    expect(row['reservation_id']).toBe('res-happy');
    expect(row['payment_id']).toBe('pay-happy');
    expect((await world.attempts(id)).map((a) => `${a.step}:${a.state_after}`)).toEqual([
      'risk:RESERVING',
      'reserve:DISBURSING',
      'disburse:COMPLETED',
    ]);
    expect(await world.outbox(id)).toEqual(['FundingRequestReceived', 'FundingRequestCompleted']);
  });

  it('FS-07 an unknown Reserve is retried with the same key and body until it answers', async () => {
    const calls = world.capacity.reserves.length;
    world.capacity.onReserve = (_call, index) =>
      index - calls < 2 ? { error: status.UNAVAILABLE } : created('res-retry');
    const id = await world.submit({ invoiceId: 'inv-retry' });
    const driver = world.driver();
    // Each unknown outcome backs off; the driver's random() is fixed at 0, so retries are due at once.
    await world.drain(driver);

    expect((await world.row(id))['state']).toBe('COMPLETED');
    const mine = world.capacity.reserves.slice(calls);
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((c) => c.metadata['idempotency-key']))).toEqual(
      new Set([`funding:${id}:reserve`]),
    );
    expect(new Set(mine.map((c) => Buffer.from(c.bytes).toString('hex'))).size).toBe(1);
  });
});

describe('saga driver: its own capacity fake', () => {
  it('FS-05 a fresh fake per test file does not leak calls between worlds', async () => {
    const other = await startFakeCapacity();
    expect(other.reserves).toHaveLength(0);
    await other.close();
  });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Lets a business deadline of 1 ms pass between the call and the record. */
const pastTheDeadline = {
  beforeRecord: async (): Promise<void> => {
    await sleep(8);
  },
};

describe('saga driver: unknown reserve, compensation (ADR 025)', () => {
  it('FS-09 an unknown Reserve past its deadline is repeated under the same key; a CREATED answer is released; FAILED', async () => {
    const reserves = world.capacity.reserves.length;
    const releases = world.capacity.releases.length;
    world.capacity.onReserve = (_call, index) =>
      index === reserves ? { error: status.UNAVAILABLE } : created('res-late');
    world.capacity.onRelease = () => released();
    const id = await world.submit({ invoiceId: 'inv-late' });
    await world.drain(world.driver({ saga: { reserveDeadlineMs: 1 }, hooks: pastTheDeadline }));

    expect((await world.row(id))['state']).toBe('FAILED');
    const mine = world.capacity.reserves.slice(reserves);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((c) => c.metadata['idempotency-key']))).toEqual(
      new Set([`funding:${id}:reserve`]),
    );
    const sent = world.capacity.releases.slice(releases);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request).toMatchObject({
      reservationId: 'res-late',
      releaseRef: `funding:${id}:compensation`,
    });
    expect(world.rail.calls.filter((c) => c.invoiceId === 'inv-late')).toHaveLength(0);
    expect(
      (await world.attempts(id)).map((a) => `${a.step}:${a.outcome_class}:${a.state_after}`),
    ).toEqual([
      'risk:success:RESERVING',
      'reserve:unknown:COMPENSATING',
      'reserve:success:COMPENSATING',
      'release:success:FAILED',
    ]);
    expect(await world.outbox(id)).toEqual(['FundingRequestReceived', 'FundingRequestFailed']);
  });

  it('FS-09 when the repeated Reserve is a definite failure nothing was held: FAILED, no release', async () => {
    const reserves = world.capacity.reserves.length;
    const releases = world.capacity.releases.length;
    world.capacity.onReserve = (_call, index) =>
      index === reserves
        ? { error: status.UNAVAILABLE }
        : { error: status.FAILED_PRECONDITION, reason: 'insufficient-capacity' };
    const id = await world.submit({ invoiceId: 'inv-nothing-held' });
    await world.drain(world.driver({ saga: { reserveDeadlineMs: 1 }, hooks: pastTheDeadline }));

    expect((await world.row(id))['state']).toBe('FAILED');
    expect(world.capacity.releases.length).toBe(releases);
  });

  it('FS-09 a reservation still unknown after the resolution limit parks the request: NEEDS_ATTENTION, alert, no release', async () => {
    const releases = world.capacity.releases.length;
    world.capacity.onReserve = () => ({ error: status.UNAVAILABLE });
    const alerts: string[] = [];
    const id = await world.submit({ invoiceId: 'inv-unresolved' });
    await world.drain(
      world.driver({
        saga: { reserveDeadlineMs: 1, reserveResolutionLimitMs: 1 },
        hooks: { ...pastTheDeadline, onAlert: (claim) => alerts.push(claim.request.id) },
      }),
    );

    const row = await world.row(id);
    expect(row['state']).toBe('NEEDS_ATTENTION');
    expect(row['reason']).toBe('reserve-unresolved');
    expect(alerts).toEqual([id]);
    expect(world.capacity.releases.length).toBe(releases);
    expect(await world.outbox(id)).toEqual([
      'FundingRequestReceived',
      'FundingRequestNeedsAttention',
    ]);
  });

  it('FS-10 an unknown disbursement is retried (lookup first), never released; the rail answering later completes it', async () => {
    world.capacity.onReserve = () => created('res-slow-rail');
    const releases = world.capacity.releases.length;
    let attempts = 0;
    world.rail.onDisburse = () => {
      attempts += 1;
      return attempts <= 3 ? { kind: 'unknown' } : { kind: 'paid', paymentId: 'pay-late' };
    };
    const calls = world.rail.calls.length;
    const id = await world.submit({ invoiceId: 'inv-slow-rail' });
    await world.drain(world.driver());

    expect((await world.row(id))['state']).toBe('COMPLETED');
    const mine = world.rail.calls.slice(calls);
    expect(mine.map((c) => c.lookupFirst)).toEqual([false, true, true, true]);
    expect(new Set(mine.map((c) => c.key))).toEqual(new Set([`funding:${id}:disburse`]));
    expect(world.capacity.releases.length).toBe(releases);
  });

  it('FS-10 a rail that times out on every attempt: after the deadline NEEDS_ATTENTION, reservation held, no release, alert', async () => {
    world.capacity.onReserve = () => created('res-held');
    world.rail.onDisburse = () => ({ kind: 'unknown' });
    const releases = world.capacity.releases.length;
    const alerts: string[] = [];
    const id = await world.submit({ invoiceId: 'inv-dead-rail' });
    await world.drain(
      world.driver({
        saga: { disburseDeadlineMs: 1 },
        hooks: { ...pastTheDeadline, onAlert: (claim) => alerts.push(claim.request.id) },
      }),
    );

    const row = await world.row(id);
    expect(row['state']).toBe('NEEDS_ATTENTION');
    expect(row['reason']).toBe('disbursement-unknown');
    expect(row['reservation_id']).toBe('res-held');
    expect(world.capacity.releases.length).toBe(releases);
    expect(alerts).toEqual([id]);
    expect(await world.outbox(id)).toEqual([
      'FundingRequestReceived',
      'FundingRequestNeedsAttention',
    ]);
    // Parked: no step is due, whatever the clock says.
    expect(await world.driver().runOnce()).toBe(0);
  });

  it('FS-06 a declined payment compensates: Release with the compensation ref, then FAILED', async () => {
    world.capacity.onReserve = () => created('res-declined');
    world.capacity.onRelease = () => released();
    world.rail.onDisburse = () => ({ kind: 'declined' });
    const releases = world.capacity.releases.length;
    const id = await world.submit({ invoiceId: 'inv-declined' });
    await world.drain(world.driver());

    expect((await world.row(id))['state']).toBe('FAILED');
    const sent = world.capacity.releases.slice(releases);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metadata['idempotency-key']).toBe(`funding:${id}:release`);
    expect(sent[0]?.request).toMatchObject({
      reservationId: 'res-declined',
      releaseRef: `funding:${id}:compensation`,
      reason: 2,
    });
    expect((await world.attempts(id)).map((a) => `${a.step}:${a.state_after}`)).toEqual([
      'risk:RESERVING',
      'reserve:DISBURSING',
      'disburse:COMPENSATING',
      'release:FAILED',
    ]);
  });

  it('FS-11 a compensation is retried without a deadline, with the same key, until capacity answers', async () => {
    world.capacity.onReserve = () => created('res-stuck');
    world.rail.onDisburse = () => ({ kind: 'declined' });
    const releases = world.capacity.releases.length;
    world.capacity.onRelease = (_call, index) =>
      index - releases < 6 ? { error: status.UNAVAILABLE } : released();
    const id = await world.submit({ invoiceId: 'inv-stuck' });
    // Both limits are 1 ms: a deadline on the compensation would park it long before the 7th try.
    const driver = world.driver({
      saga: { reserveDeadlineMs: 1, disburseDeadlineMs: 1, reserveResolutionLimitMs: 1 },
      hooks: pastTheDeadline,
    });
    await world.drain(driver);

    expect((await world.row(id))['state']).toBe('FAILED');
    const sent = world.capacity.releases.slice(releases);
    expect(sent).toHaveLength(7);
    expect(new Set(sent.map((c) => c.metadata['idempotency-key']))).toEqual(
      new Set([`funding:${id}:release`]),
    );
    expect(new Set(sent.map((c) => c.request.releaseRef))).toEqual(
      new Set([`funding:${id}:compensation`]),
    );
  });

  it('FS-11 release-exceeds-remaining (already released by someone else) counts as compensated', async () => {
    world.capacity.onReserve = () => created('res-gone');
    world.rail.onDisburse = () => ({ kind: 'declined' });
    world.capacity.onRelease = () => ({
      error: status.FAILED_PRECONDITION,
      reason: 'release-exceeds-remaining',
    });
    const id = await world.submit({ invoiceId: 'inv-gone' });
    await world.drain(world.driver());
    expect((await world.row(id))['state']).toBe('FAILED');
    expect(await world.outbox(id)).toEqual(['FundingRequestReceived', 'FundingRequestFailed']);
  });

  it('FS-11 an unexpected definite release failure parks the request for an operator: NEEDS_ATTENTION, alert', async () => {
    world.capacity.onReserve = () => created('res-odd');
    world.rail.onDisburse = () => ({ kind: 'declined' });
    world.capacity.onRelease = () => ({ error: status.NOT_FOUND, reason: 'not-found' });
    const alerts: string[] = [];
    const id = await world.submit({ invoiceId: 'inv-odd' });
    await world.drain(
      world.driver({ hooks: { onAlert: (claim) => alerts.push(claim.request.id) } }),
    );
    const row = await world.row(id);
    expect(row['state']).toBe('NEEDS_ATTENTION');
    expect(row['reason']).toBe('release-failed:not-found');
    expect(alerts).toEqual([id]);
  });
});

/** A store whose `record` fails on demand: the call succeeded, the result is lost (FS-08). */
class LosingStore implements SagaStore {
  failNext = 0;
  constructor(private readonly inner: SagaStore) {}
  claimDue(owner: string, leaseMs: number, limit: number): Promise<readonly Claim[]> {
    return this.inner.claimDue(owner, leaseMs, limit);
  }
  now(): Promise<number> {
    return this.inner.now();
  }
  record(claim: Claim, transition: Transition): Promise<boolean> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return Promise.reject(new Error('injected: recording the result failed'));
    }
    return this.inner.record(claim, transition);
  }
}

describe('saga driver: a lost result is a replay (ADR 025 exactly-once effect)', () => {
  it('FS-08 Reserve succeeded but recording failed: the driver repeats it with the same key and records one result', async () => {
    const effects = new Map<string, string>();
    world.capacity.onReserve = (call) => {
      const key = call.metadata['idempotency-key'] ?? '';
      if (!effects.has(key)) effects.set(key, `res-${(effects.size + 1).toString()}-fs08`);
      return created(effects.get(key) ?? '');
    };
    world.rail.onDisburse = () => ({ kind: 'paid', paymentId: 'pay-fs08' });
    const losing = new LosingStore(world.store);
    const errors: unknown[] = [];
    const driver = world.driver({
      store: losing,
      leaseMs: 300,
      hooks: { onError: (_claim, error) => errors.push(error) },
    });
    const reserves = world.capacity.reserves.length;
    const id = await world.submit({ invoiceId: 'inv-fs08-reserve' });

    await driver.runOnce(); // risk
    losing.failNext = 1;
    await driver.runOnce(); // Reserve called, result lost
    expect(errors).toHaveLength(1);
    expect((await world.row(id))['state']).toBe('RESERVING');
    await sleep(450); // the lease expires
    await world.drain(driver);

    expect((await world.row(id))['state']).toBe('COMPLETED');
    const mine = world.capacity.reserves.slice(reserves);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((c) => c.metadata['idempotency-key']))).toEqual(
      new Set([`funding:${id}:reserve`]),
    );
    expect(effects.size).toBeGreaterThanOrEqual(1);
    const attempts = await world.attempts(id);
    expect(attempts.filter((a) => a.step === 'reserve')).toHaveLength(1);
    expect(attempts.filter((a) => a.step === 'disburse')).toHaveLength(1);
  });

  it('FS-08 Disburse succeeded but recording failed: the rail is asked again with the same key, one result is recorded', async () => {
    world.capacity.onReserve = () => created('res-fs08-disburse');
    const paid = new Map<string, string>();
    world.rail.onDisburse = (call) => {
      if (!paid.has(call.key)) paid.set(call.key, `pay-${(paid.size + 1).toString()}`);
      return { kind: 'paid', paymentId: paid.get(call.key) ?? '' };
    };
    const losing = new LosingStore(world.store);
    const driver = world.driver({ store: losing, leaseMs: 300 });
    const calls = world.rail.calls.length;
    const id = await world.submit({ invoiceId: 'inv-fs08-disburse' });

    await driver.runOnce(); // risk
    await driver.runOnce(); // reserve
    losing.failNext = 1;
    await driver.runOnce(); // disburse called, result lost
    expect((await world.row(id))['state']).toBe('DISBURSING');
    await sleep(450);
    await world.drain(driver);

    const row = await world.row(id);
    expect(row['state']).toBe('COMPLETED');
    expect(row['payment_id']).toBe(paid.get(`funding:${id}:disburse`));
    const mine = world.rail.calls.slice(calls);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((c) => c.key))).toEqual(new Set([`funding:${id}:disburse`]));
    expect((await world.attempts(id)).filter((a) => a.step === 'disburse')).toHaveLength(1);
  });
});
