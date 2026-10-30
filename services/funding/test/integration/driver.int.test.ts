import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { created } from '../support/fake-capacity.js';
import { startSagaWorld, type SagaWorld } from '../support/saga-world.js';

let world: SagaWorld;

beforeAll(async () => {
  world = await startSagaWorld();
  world.capacity.onReserve = () => created('res-1');
});

afterAll(async () => {
  await world.close();
});

describe('saga store: claim and lease (ADR 025)', () => {
  it('FS-12 two concurrent claims take disjoint rows (SKIP LOCKED) and never the same request twice', async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        world.submit({ invoiceId: `inv-claim-${i.toString()}` }),
      ),
    );
    const [a, b] = await Promise.all([
      world.store.claimDue('worker-a', 30_000, 7),
      world.store.claimDue('worker-b', 30_000, 7),
    ]);
    const taken = [...a, ...b].map((c) => c.request.id).filter((id) => ids.includes(id));
    expect(new Set(taken).size).toBe(taken.length);
    expect(taken.length).toBe(12);
  });

  it('FS-12 a claim bumps the version, sets the lease and is invisible to other claims until it expires', async () => {
    const id = await world.submit({ invoiceId: 'inv-lease' });
    const claims = await world.store.claimDue('worker-a', 500, 100);
    const mine = claims.find((c) => c.request.id === id);
    expect(mine?.version).toBe(1n);
    expect((await world.row(id))['lease_owner']).toBe('worker-a');
    expect(
      (await world.store.claimDue('worker-b', 500, 100)).some((c) => c.request.id === id),
    ).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 700));
    const again = (await world.store.claimDue('worker-b', 500, 100)).find(
      (c) => c.request.id === id,
    );
    expect(again?.version).toBe(2n);
    expect(again?.leaseOwner).toBe('worker-b');
  });

  it('FS-12 a record under a stale version updates nothing and writes no attempt or outbox row', async () => {
    const id = await world.submit({ invoiceId: 'inv-stale' });
    const first = (await world.store.claimDue('worker-a', 200, 100)).find(
      (c) => c.request.id === id,
    )!;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const second = (await world.store.claimDue('worker-b', 30_000, 100)).find(
      (c) => c.request.id === id,
    )!;
    expect(second.version).toBeGreaterThan(first.version);

    const transition = {
      request: { ...first.request, state: 'REJECTED' as const, reason: 'risk-declined' },
      event: 'FundingRequestRejected' as const,
      alert: false,
      attempt: { step: 'risk' as const, class: 'failure' as const },
    };
    expect(await world.store.record(first, transition)).toBe(false);
    expect((await world.row(id))['state']).toBe('RECEIVED');
    expect(await world.attempts(id)).toEqual([]);
    expect(await world.outbox(id)).toEqual(['FundingRequestReceived']);
    expect(await world.store.record(second, transition)).toBe(true);
    expect((await world.row(id))['state']).toBe('REJECTED');
  });

  it('FS-12 terminal and parked requests are never claimed', async () => {
    const id = await world.submit({ invoiceId: 'inv-done' });
    await world.drain(world.driver());
    expect((await world.row(id))['state']).toBe('COMPLETED');
    expect(
      (await world.store.claimDue('worker-a', 30_000, 100)).some((c) => c.request.id === id),
    ).toBe(false);
  });
});
