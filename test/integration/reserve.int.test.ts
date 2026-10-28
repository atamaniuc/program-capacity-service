import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  count,
  programRow,
  seedFxRate,
  seedProgram,
  startCapacityWorld,
  type CapacityWorld,
} from '../support/capacity-world.js';
import type { ReserveCapacityCommand } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';

let sequence = 0;

describe('reserve', () => {
  let world: CapacityWorld;

  function command(overrides: Partial<ReserveCapacityCommand> = {}): ReserveCapacityCommand {
    return {
      tenantId: 'bank-a',
      actor: 'svc-orders',
      requestId: `req-${++sequence}`,
      programId: 'usd-program',
      invoiceId: 'INV-1',
      invoiceAmount: { minor: 100_000_000n, currency: 'EUR' },
      ...overrides,
    };
  }

  beforeAll(async () => {
    world = await startCapacityWorld();
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'usd-program',
      limitMinor: 100_000_000_000n,
    });
    await seedFxRate(world, { base: 'EUR', quote: 'USD', rate: '1.1' });
  });

  afterAll(async () => {
    await world.close();
  });

  it('AC-04 replays the same terms with 200 and refuses a different amount with 409', async () => {
    const first = await world.reserve.execute(command());
    expect(first).toMatchObject({
      ok: true,
      status: 201,
      value: {
        invoiceAmount: { value: '1000000.00', currency: 'EUR' },
        reservedAmount: { value: '1100000.00', currency: 'USD' },
        fx: { rate: '1.1000000000', source: 'treasury' },
      },
    });

    const same = await world.reserve.execute(command());
    expect(same).toMatchObject({ ok: true, status: 200 });
    expect(same.ok && first.ok && same.value.reservationId).toBe(
      first.ok && first.value.reservationId,
    );

    const different = await world.reserve.execute(
      command({ invoiceAmount: { minor: 100_000_001n, currency: 'EUR' } }),
    );
    expect(different).toMatchObject({
      ok: false,
      problem: { type: 'reservation-conflict', status: 409 },
    });

    expect(await count(world, 'reservation')).toBe(1);
    expect(await count(world, 'ledger_entry')).toBe(1);
    expect((await programRow(world, 'bank-a', 'usd-program')).reserved_minor).toBe('110000000');
  });

  it('AC-04 refuses a re-reserve of a fully released invoice with 409 (A7)', async () => {
    const created = await world.reserve.execute(command({ invoiceId: 'INV-REL' }));
    if (!created.ok) throw new Error('setup');
    const released = await world.release.execute({
      tenantId: 'bank-a',
      actor: 'svc',
      requestId: 'r',
      programId: 'usd-program',
      reservationId: created.value.reservationId,
      releaseRef: 'all',
      reason: 'CANCELLED',
    });
    expect(released.ok).toBe(true);
    expect(await world.reserve.execute(command({ invoiceId: 'INV-REL' }))).toMatchObject({
      ok: false,
      problem: { type: 'reservation-conflict' },
    });
  });

  it('FR-08 uses the newest rate younger than the maximum age and rounds up to the program unit', async () => {
    await seedFxRate(world, {
      base: 'GBP',
      quote: 'USD',
      rate: '1.2500000001',
      asOf: new Date(Date.now() - 3600_000),
      source: 'treasury-live',
    });
    await seedFxRate(world, {
      base: 'GBP',
      quote: 'USD',
      rate: '9.9',
      asOf: new Date(Date.now() - 48 * 3600_000),
    });
    const outcome = await world.reserve.execute(
      command({ invoiceId: 'INV-GBP', invoiceAmount: { minor: 1n, currency: 'GBP' } }),
    );
    // GBP 0.01 x 1.2500000001 = USD 0.012500000001 -> rounds up to USD 0.02
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        reservedAmount: { value: '0.02', currency: 'USD' },
        fx: { rate: '1.2500000001', source: 'treasury-live' },
      },
    });
  });

  it('FR-08 rejects with fx-rate-unavailable when only an old rate exists, changing nothing', async () => {
    await seedFxRate(world, {
      base: 'CHF',
      quote: 'USD',
      rate: '1.1',
      asOf: new Date(Date.now() - 25 * 3600_000),
    });
    const before = await programRow(world, 'bank-a', 'usd-program');
    const outcome = await world.reserve.execute(
      command({ invoiceId: 'INV-CHF', invoiceAmount: { minor: 100n, currency: 'CHF' } }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      problem: { type: 'fx-rate-unavailable', status: 422 },
    });
    expect(await programRow(world, 'bank-a', 'usd-program')).toEqual(before);
  });

  it('FR-02 rejects suspended and over-limit programs and leaves them untouched', async () => {
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'suspended',
      limitMinor: 1_000_000n,
      status: 'SUSPENDED',
    });
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'cut',
      limitMinor: 300_000_000n,
      reservedMinor: 362_000_000n,
    });
    const suspended = await world.reserve.execute(
      command({ programId: 'suspended', invoiceAmount: { minor: 1n, currency: 'USD' } }),
    );
    const overLimit = await world.reserve.execute(
      command({ programId: 'cut', invoiceAmount: { minor: 1n, currency: 'USD' } }),
    );
    expect(suspended).toMatchObject({ ok: false, problem: { type: 'program-suspended' } });
    expect(overLimit).toMatchObject({ ok: false, problem: { type: 'program-over-limit' } });
    const capacity = await world.getCapacity.execute({ tenantId: 'bank-a', programId: 'cut' });
    expect(capacity).toMatchObject({
      ok: true,
      value: { available: '0.00', overLimitBy: '620000.00', utilization: '1.2066' },
    });
  });

  it('FR-02 answers not-found for an unknown program', async () => {
    expect(await world.reserve.execute(command({ programId: 'missing' }))).toMatchObject({
      ok: false,
      problem: { type: 'not-found' },
    });
  });

  it('FR-02 keeps the ledger sums equal to the projection (I5)', async () => {
    const { rows } = await sql<{ delta: string; reserved: string }>`
      SELECT coalesce(sum(l.delta_reserved_minor), 0)::text AS delta, p.reserved_minor::text AS reserved
        FROM program p LEFT JOIN ledger_entry l ON l.tenant_id = p.tenant_id AND l.program_id = p.id
       WHERE p.tenant_id = 'bank-a' AND p.id = 'usd-program'
       GROUP BY p.reserved_minor`.execute(world.persistence.db);
    expect(rows[0]?.delta).toBe(rows[0]?.reserved);
  });
});
