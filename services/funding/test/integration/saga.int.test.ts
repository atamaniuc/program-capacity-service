import { status } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { created, existing, startFakeCapacity } from '../support/fake-capacity.js';
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
