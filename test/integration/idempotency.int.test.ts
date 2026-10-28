import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  count,
  holdFirstLedgerAppend,
  programRow,
  seedProgram,
  startCapacityWorld,
  type CapacityWorld,
} from '../support/capacity-world.js';
import type { ReserveCapacityCommand } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import type { UnitOfWork } from '#src/capacity/application/ports/index.js';

function command(overrides: Partial<ReserveCapacityCommand> = {}): ReserveCapacityCommand {
  return {
    tenantId: 'bank-a',
    actor: 'svc-orders',
    requestId: 'req',
    programId: 'p1',
    invoiceId: 'INV-1',
    invoiceAmount: { minor: 100_000n, currency: 'USD' },
    idempotencyKey: 'K1',
    ...overrides,
  };
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition not reached in time');
}

describe('idempotency', () => {
  let world: CapacityWorld;
  let openGate: () => void;
  let firstHeld: () => void;
  let held: Promise<void>;
  let failNextLedger = false;

  beforeAll(async () => {
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    held = new Promise<void>((resolve) => {
      firstHeld = resolve;
    });
    world = await startCapacityWorld({
      poolSize: 10,
      timeouts: { lockTimeoutMs: 30_000, statementTimeoutMs: 60_000 },
      wrapUow: (uow: UnitOfWork): UnitOfWork => {
        const holding = holdFirstLedgerAppend(uow, gate, firstHeld);
        return {
          run: (work) =>
            holding.run((tx) =>
              work({
                ...tx,
                ledger: {
                  append: async (entry) => {
                    if (failNextLedger) {
                      failNextLedger = false;
                      throw new Error('simulated crash before commit');
                    }
                    await tx.ledger.append(entry);
                  },
                },
              }),
            ),
        };
      },
    });
    await seedProgram(world, { tenantId: 'bank-a', id: 'p1', limitMinor: 100_000_000n });
    await seedProgram(world, { tenantId: 'bank-a', id: 'small', limitMinor: 100_000n });
    await seedProgram(world, { tenantId: 'bank-b', id: 'p1', limitMinor: 100_000_000n });
  });

  afterAll(async () => {
    openGate();
    await world.close();
  });

  it('AC-02 a concurrent duplicate waits for the first, then returns its stored 201 with one ledger entry', async () => {
    const first = world.reserve.execute(command());
    await held;

    let secondSettled = false;
    const second = world.reserve.execute(command({ requestId: 'req-dup' })).finally(() => {
      secondSettled = true;
    });
    // The duplicate is blocked on the first transaction's uncommitted key row at the unique index.
    await waitFor(async () => {
      const { rows } = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND wait_event = 'transactionid' AND query ILIKE '%INSERT INTO idempotency_key%'`.execute(
        world.persistence.db,
      );
      return rows[0]?.n === '1';
    });
    expect(secondSettled).toBe(false);

    openGate();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: true, status: 201 });
    expect(b).toEqual(a);
    expect(await count(world, 'ledger_entry')).toBe(1);
    expect(await count(world, 'reservation')).toBe(1);
    expect((await programRow(world, 'bank-a', 'p1')).reserved_minor).toBe('100000');
    expect(await count(world, 'idempotency_key', 'status_code = 201')).toBe(1);
  });

  it('AC-02 a later sequential duplicate gets the identical stored response', async () => {
    const again = await world.reserve.execute(command({ requestId: 'req-late' }));
    expect(again).toMatchObject({ ok: true, status: 201, value: { invoiceId: 'INV-1' } });
    expect(await count(world, 'ledger_entry')).toBe(1);
  });

  it('AC-03 a different body under the same key answers idempotency-key-mismatch and changes nothing', async () => {
    const outcome = await world.reserve.execute(
      command({ invoiceAmount: { minor: 200_000n, currency: 'USD' } }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      problem: { type: 'idempotency-key-mismatch', status: 422 },
    });
    expect(await count(world, 'reservation')).toBe(1);
    expect(await count(world, 'ledger_entry')).toBe(1);
    expect((await programRow(world, 'bank-a', 'p1')).reserved_minor).toBe('100000');
  });

  it('AC-03 keys are scoped to the tenant: the same key for another tenant is a new request', async () => {
    const outcome = await world.reserve.execute(command({ tenantId: 'bank-b' }));
    expect(outcome).toMatchObject({ ok: true, status: 201 });
    expect(await count(world, 'idempotency_key', "key = 'K1'")).toBe(2);
  });

  it('AC-17 replays a stored 422 after capacity was freed; a new key is a new attempt', async () => {
    const body = command({
      programId: 'small',
      invoiceId: 'INV-BIG',
      idempotencyKey: 'K-REJECTED',
      invoiceAmount: { minor: 150_000n, currency: 'USD' },
    });
    const rejected = await world.reserve.execute(body);
    expect(rejected).toMatchObject({ ok: false, problem: { type: 'insufficient-capacity' } });

    await sql`UPDATE program SET credit_limit_minor = 1000000 WHERE id = 'small'`.execute(
      world.persistence.db,
    );
    const replay = await world.reserve.execute(body);
    expect(replay).toEqual(rejected);
    expect(await count(world, 'reservation', "program_id = 'small'")).toBe(0);
    expect(await count(world, 'ledger_entry', "program_id = 'small'")).toBe(0);

    const fresh = await world.reserve.execute({ ...body, idempotencyKey: 'K-NEW' });
    expect(fresh).toMatchObject({ ok: true, status: 201 });
  });

  it('AC-02 an infrastructure failure rolls back everything including the key, so a retry runs again', async () => {
    failNextLedger = true;
    await expect(
      world.reserve.execute(command({ invoiceId: 'INV-CRASH', idempotencyKey: 'K-CRASH' })),
    ).rejects.toThrow('simulated crash');
    expect(await count(world, 'idempotency_key', "key = 'K-CRASH'")).toBe(0);
    expect(await count(world, 'reservation', "invoice_id = 'INV-CRASH'")).toBe(0);

    const retry = await world.reserve.execute(
      command({ invoiceId: 'INV-CRASH', idempotencyKey: 'K-CRASH' }),
    );
    expect(retry).toMatchObject({ ok: true, status: 201 });
  });

  it('AC-02 many concurrent duplicates with one key produce exactly one reservation', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        world.reserve.execute(
          command({ invoiceId: 'INV-MANY', idempotencyKey: 'K-MANY', requestId: `r${i}` }),
        ),
      ),
    );
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(await count(world, 'reservation', "invoice_id = 'INV-MANY'")).toBe(1);
    expect(await count(world, 'ledger_entry', "cause_id = 'K-MANY'")).toBe(1);
  });
});
