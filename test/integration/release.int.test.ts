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
import type { ReleaseReservationCommand } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';

describe('release', () => {
  let world: CapacityWorld;
  let invoiceCounter = 0;

  async function reserveEur(minor = 100_000_000n): Promise<string> {
    const outcome = await world.reserve.execute({
      tenantId: 'bank-a',
      actor: 'svc-orders',
      requestId: 'req',
      programId: 'usd-program',
      invoiceId: `INV-${++invoiceCounter}`,
      invoiceAmount: { minor, currency: 'EUR' },
    });
    if (!outcome.ok) throw new Error(`setup reserve failed: ${outcome.problem.type}`);
    return outcome.value.reservationId;
  }

  function release(
    reservationId: string,
    overrides: Partial<ReleaseReservationCommand> = {},
  ): ReturnType<CapacityWorld['release']['execute']> {
    return world.release.execute({
      tenantId: 'bank-a',
      actor: 'svc-treasury',
      requestId: 'req-rel',
      programId: 'usd-program',
      reservationId,
      releaseRef: 'rel-1',
      reason: 'REPAID',
      ...overrides,
    });
  }

  beforeAll(async () => {
    world = await startCapacityWorld({ poolSize: 30 });
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'usd-program',
      limitMinor: 1_000_000_000_000n,
    });
    await seedFxRate(world, { base: 'EUR', quote: 'USD', rate: '1.1' });
  });

  afterAll(async () => {
    await world.close();
  });

  it('AC-05 three releases of EUR 333,333.33 / 333,333.33 / 333,333.34 free exactly USD 1,100,000.00', async () => {
    const reservationId = await reserveEur();
    const before = await programRow(world, 'bank-a', 'usd-program');
    expect(before.reserved_minor).toBe('110000000');

    const amounts = [33_333_333n, 33_333_333n, 33_333_334n];
    const outcomes = [];
    for (const [index, minor] of amounts.entries()) {
      outcomes.push(
        await release(reservationId, {
          releaseRef: `split-${index}`,
          amount: { minor, currency: 'EUR' },
        }),
      );
    }
    expect(outcomes.map((o) => o.ok && o.value.releasedAmount.value)).toEqual([
      '366666.66',
      '366666.66',
      '366666.68',
    ]);
    expect(outcomes.map((o) => o.ok && o.value.reservationStatus)).toEqual([
      'PARTIALLY_RELEASED',
      'PARTIALLY_RELEASED',
      'RELEASED',
    ]);

    const reservation = await sql<{ released_minor: string; amount_minor: string; status: string }>`
      SELECT released_minor::text, amount_minor::text, status FROM reservation WHERE id = ${reservationId}::uuid`.execute(
      world.persistence.db,
    );
    expect(reservation.rows[0]).toEqual({
      released_minor: '110000000',
      amount_minor: '110000000',
      status: 'RELEASED',
    });
    expect((await programRow(world, 'bank-a', 'usd-program')).reserved_minor).toBe('0');
    const ledger = await sql<{ sum: string }>`
      SELECT sum(delta_reserved_minor)::text AS sum FROM ledger_entry
       WHERE reservation_id = ${reservationId}::uuid`.execute(world.persistence.db);
    expect(ledger.rows[0]?.sum).toBe('0');
  });

  it('AC-06 refuses a release above the remainder, replays the same body and refuses a different body', async () => {
    const reservationId = await reserveEur();
    const first = await release(reservationId, {
      releaseRef: 'X',
      amount: { minor: 40_000_000n, currency: 'EUR' },
    });
    expect(first).toMatchObject({
      ok: true,
      status: 200,
      value: { reservationStatus: 'PARTIALLY_RELEASED' },
    });
    const afterFirst = await programRow(world, 'bank-a', 'usd-program');
    const ledgerAfterFirst = await count(world, 'ledger_entry', "kind = 'RELEASE'");

    const above = await release(reservationId, {
      releaseRef: 'Y',
      amount: { minor: 60_000_001n, currency: 'EUR' },
    });
    expect(above).toMatchObject({
      ok: false,
      problem: { type: 'release-exceeds-remaining', status: 422 },
    });

    const replay = await release(reservationId, {
      releaseRef: 'X',
      amount: { minor: 40_000_000n, currency: 'EUR' },
    });
    expect(replay).toEqual(first);

    const different = await release(reservationId, {
      releaseRef: 'X',
      amount: { minor: 40_000_001n, currency: 'EUR' },
    });
    expect(different).toMatchObject({
      ok: false,
      problem: { type: 'release-ref-mismatch', status: 422 },
    });

    expect(await programRow(world, 'bank-a', 'usd-program')).toEqual(afterFirst);
    expect(await count(world, 'ledger_entry', "kind = 'RELEASE'")).toBe(ledgerAfterFirst);
    expect(await count(world, 'reservation_release', `reservation_id = '${reservationId}'`)).toBe(
      1,
    );
  });

  it('AC-06 concurrent duplicates of one release_ref have exactly one effect', async () => {
    const reservationId = await reserveEur();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        release(reservationId, {
          releaseRef: 'dup',
          amount: { minor: 10_000_000n, currency: 'EUR' },
        }),
      ),
    );
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(outcomes[0]).toMatchObject({
      ok: true,
      value: { releasedAmount: { value: '110000.00' } },
    });
    expect(
      await count(
        world,
        'ledger_entry',
        `reservation_id = '${reservationId}' AND kind = 'RELEASE'`,
      ),
    ).toBe(1);
  });

  it('AC-05 concurrent releases and reserves do not deadlock and keep reserved equal to the sum of open reservations (I1)', async () => {
    const reservationIds = await Promise.all([reserveEur(), reserveEur(), reserveEur()]);
    const work: Promise<unknown>[] = [];
    for (const [r, reservationId] of reservationIds.entries()) {
      for (let i = 0; i < 5; i++) {
        work.push(
          release(reservationId, {
            releaseRef: `c-${r}-${i}`,
            amount: { minor: i === 4 ? 20_000_000n : 20_000_000n, currency: 'EUR' },
          }),
        );
      }
    }
    for (let i = 0; i < 10; i++) {
      work.push(
        world.reserve.execute({
          tenantId: 'bank-a',
          actor: 'svc',
          requestId: `rq-${i}`,
          programId: 'usd-program',
          invoiceId: `INV-CONC-${i}`,
          invoiceAmount: { minor: 5_000n, currency: 'USD' },
        }),
      );
    }
    await Promise.all(work);

    const { rows } = await sql<{ reserved: string; open: string }>`
      SELECT p.reserved_minor::text AS reserved,
             coalesce(sum(r.amount_minor - r.released_minor) FILTER (WHERE r.status <> 'RELEASED'), 0)::text AS open
        FROM program p LEFT JOIN reservation r ON r.tenant_id = p.tenant_id AND r.program_id = p.id
       WHERE p.tenant_id = 'bank-a' AND p.id = 'usd-program'
       GROUP BY p.reserved_minor`.execute(world.persistence.db);
    expect(rows[0]?.reserved).toBe(rows[0]?.open);
    const ledger = await sql<{ delta: string }>`
      SELECT sum(delta_reserved_minor)::text AS delta FROM ledger_entry
       WHERE tenant_id = 'bank-a' AND program_id = 'usd-program'`.execute(world.persistence.db);
    expect(ledger.rows[0]?.delta).toBe(rows[0]?.reserved);
  });

  it('AC-06 answers not-found for a reservation of another program or tenant', async () => {
    const reservationId = await reserveEur();
    expect(await release(reservationId, { tenantId: 'bank-b' })).toMatchObject({
      ok: false,
      problem: { type: 'not-found' },
    });
    expect(await release('not-a-uuid')).toMatchObject({
      ok: false,
      problem: { type: 'not-found' },
    });
  });
});
