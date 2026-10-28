import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  count,
  programRow,
  seedProgram,
  startCapacityWorld,
  type CapacityWorld,
} from '../support/capacity-world.js';

describe('reserve under concurrency', () => {
  let world: CapacityWorld;

  beforeAll(async () => {
    world = await startCapacityWorld({ poolSize: 50 });
  });

  afterAll(async () => {
    await world.close();
  });

  it('AC-01 exactly 10 of 50 concurrent reservations succeed', async () => {
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'grand-usd',
      limitMinor: 1_000_000_000n,
      reservedMinor: 900_000_000n,
    });

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        world.reserve.execute({
          tenantId: 'bank-a',
          actor: 'svc-orders',
          requestId: `req-${index}`,
          programId: 'grand-usd',
          invoiceId: `INV-${index}`,
          invoiceAmount: { minor: 10_000_000n, currency: 'USD' },
        }),
      ),
    );

    const created = outcomes.filter((o) => o.ok && o.status === 201);
    const refused = outcomes.filter((o) => !o.ok && o.problem.type === 'insufficient-capacity');
    expect(created).toHaveLength(10);
    expect(refused).toHaveLength(40);

    const program = await programRow(world, 'bank-a', 'grand-usd');
    expect(program.reserved_minor).toBe('1000000000');
    expect(program.version).toBe('10');
    expect(await count(world, 'reservation')).toBe(10);
    expect(await count(world, 'ledger_entry', "kind = 'RESERVE'")).toBe(10);
    expect(await count(world, 'outbox_event', "type = 'ReservationCreated'")).toBe(10);

    const capacity = await world.getCapacity.execute({
      tenantId: 'bank-a',
      programId: 'grand-usd',
    });
    expect(capacity).toMatchObject({
      ok: true,
      value: { reserved: '10000000.00', available: '0.00', limit: '10000000.00' },
    });
  });
});
