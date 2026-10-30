import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { created } from '../support/fake-capacity.js';
import { CreateFundingRequest } from '#src/funding/application/funding-requests.js';
import type { CapacityGateway } from '#src/funding/application/saga-ports.js';
import { PostgresUnitOfWork } from '#src/funding/adapters/out/postgres/unit-of-work.js';
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('two drivers and a lease that expires mid-call (ADR 025)', () => {
  it('FS-12 the late result of the first driver is dropped by the version check; the receiver sees one effect', async () => {
    const effects = new Map<string, string>();
    world.capacity.onReserve = (call) => {
      const key = call.metadata['idempotency-key'] ?? '';
      if (!effects.has(key)) effects.set(key, `res-${(effects.size + 1).toString()}-fs12`);
      return created(effects.get(key) ?? '');
    };
    world.rail.onDisburse = () => ({ kind: 'paid', paymentId: 'pay-fs12' });
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let held = false;
    const slow: CapacityGateway = {
      reserve: async (call) => {
        if (!held) {
          held = true;
          await gate; // the first driver stalls inside its call
        }
        return world.gateway.reserve(call);
      },
      release: (call) => world.gateway.release(call),
    };
    const dropped: string[] = [];
    const a = world.driver({
      owner: 'driver-a',
      leaseMs: 250,
      gateway: slow,
      hooks: { onDropped: (_c, reason) => dropped.push(reason) },
    });
    const b = world.driver({ owner: 'driver-b', leaseMs: 30_000 });
    const id = await world.submit({ invoiceId: 'inv-fs12' });
    await a.runOnce(); // risk -> RESERVING

    const stalled = a.runOnce(); // claims the reserve step and stalls at the gate
    await sleep(500); // its lease has expired
    await world.drain(b); // driver B takes the step over and finishes the whole request
    expect((await world.row(id))['state']).toBe('COMPLETED');
    const attemptsBefore = await world.attempts(id);

    open();
    await stalled; // A's late Reserve answer now reaches the version check
    expect(dropped).toEqual(['lease-lost']);
    expect(await world.attempts(id)).toEqual(attemptsBefore);
    expect(attemptsBefore.filter((x) => x.step === 'reserve')).toHaveLength(1);
    expect((await world.row(id))['state']).toBe('COMPLETED');
    // Two calls reached the receiver under one key; it did one thing.
    expect(
      world.capacity.reserves.filter(
        (c) => c.metadata['idempotency-key'] === `funding:${id}:reserve`,
      ),
    ).toHaveLength(2);
    expect([...effects.keys()].filter((k) => k === `funding:${id}:reserve`)).toHaveLength(1);
  });
});

describe('a failed transition rolls back whole (ADR 025)', () => {
  const fail = async (table: string): Promise<void> => {
    const when = table === 'outbox_event' ? "WHEN (NEW.type = 'FundingRequestRejected')" : '';
    await world.persistence.pool.query(`
      CREATE OR REPLACE FUNCTION fs13_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure in ${table}'; END $$;
      CREATE TRIGGER fs13_${table} BEFORE INSERT ON ${table}
        FOR EACH ROW ${when} EXECUTE FUNCTION fs13_fail();`);
  };
  const heal = async (table: string): Promise<void> => {
    await world.persistence.pool.query(`DROP TRIGGER IF EXISTS fs13_${table} ON ${table}`);
  };

  it.each([
    ['outbox_event', 'FundingRequestRejected'],
    ['saga_step_attempt', 'risk step'],
  ])(
    'FS-13 an insert failing in %s leaves state, version, attempt log, outbox and idempotency row unchanged (%s)',
    async (table) => {
      const unitOfWork = new PostgresUnitOfWork(world.persistence);
      const created = await new CreateFundingRequest(unitOfWork).execute({
        tenantId: 'bank-a',
        idempotencyKey: `k-fs13-${table}`,
        programId: 'prg_1',
        invoiceId: `inv-fs13-${table}`,
        amount: { value: '1000000.01', currency: 'USD' }, // above the risk limit: REJECTED + outbox event
      });
      if (!created.ok) throw new Error('submit refused');
      const id = created.value.id;
      const keyRow = async (): Promise<unknown[]> =>
        (
          await world.persistence.pool.query('SELECT * FROM idempotency_key WHERE key = $1', [
            `k-fs13-${table}`,
          ])
        ).rows as unknown[];

      const claim = (await world.store.claimDue('worker-fs13', 150, 100)).find(
        (c) => c.request.id === id,
      )!;
      const snapshot = {
        row: await world.row(id),
        attempts: await world.attempts(id),
        outbox: await world.outbox(id),
        key: await keyRow(),
      };

      await fail(table);
      const errors: unknown[] = [];
      try {
        await world.driver({ hooks: { onError: (_c, e) => errors.push(e) } }).runStep(claim);
      } finally {
        await heal(table);
      }
      expect(String(errors[0])).toMatch(/injected failure/);
      expect(await world.row(id)).toEqual(snapshot.row);
      expect(await world.attempts(id)).toEqual(snapshot.attempts);
      expect(await world.outbox(id)).toEqual(snapshot.outbox);
      expect(await keyRow()).toEqual(snapshot.key);

      // Healed, the lease runs out and the same step goes through, once.
      await sleep(250);
      await world.drain(world.driver());
      expect((await world.row(id))['state']).toBe('REJECTED');
      expect(await world.attempts(id)).toHaveLength(1);
      expect(await world.outbox(id)).toEqual(['FundingRequestReceived', 'FundingRequestRejected']);
    },
  );
});
