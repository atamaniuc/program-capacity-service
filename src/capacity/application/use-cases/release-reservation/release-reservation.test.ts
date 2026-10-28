import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryWorld } from '../../../../../test/support/in-memory-ports.js';
import type { Program } from '../../../domain/index.js';
import { ReserveCapacity } from '../reserve-capacity/reserve-capacity.js';
import { ReleaseReservation, type ReleaseReservationCommand } from './release-reservation.js';

const program: Program = {
  tenantId: 'bank-a',
  id: 'grand-usd',
  currency: 'USD',
  creditLimitMinor: 10_000_000_000n,
  reservedMinor: 0n,
  status: 'ACTIVE',
  version: 0,
  treasurySeq: 0,
  platformSeq: 0,
};

describe('ReleaseReservation', () => {
  let world: InMemoryWorld;
  let release: ReleaseReservation;
  let reservationId: string;

  function command(overrides: Partial<ReleaseReservationCommand> = {}): ReleaseReservationCommand {
    return {
      tenantId: 'bank-a',
      actor: 'svc-treasury',
      requestId: 'req-r',
      programId: 'grand-usd',
      reservationId,
      releaseRef: 'rel-1',
      reason: 'REPAID',
      ...overrides,
    };
  }

  beforeEach(async () => {
    world = new InMemoryWorld();
    world.addProgram(program);
    world.addFx('EUR', 'USD', 11_000_000_000n, new Date('2026-10-28T09:00:00Z'));
    release = new ReleaseReservation({ uow: world, clock: world.clock, ids: world.ids });
    const reserve = new ReserveCapacity({
      uow: world,
      clock: world.clock,
      ids: world.ids,
      fxMaxAgeMs: 24 * 3600 * 1000,
    });
    const outcome = await reserve.execute({
      tenantId: 'bank-a',
      actor: 'svc-orders',
      requestId: 'req-0',
      programId: 'grand-usd',
      invoiceId: 'INV-1',
      invoiceAmount: { minor: 100_000_000n, currency: 'EUR' },
    });
    if (!outcome.ok) throw new Error('setup reserve failed');
    reservationId = outcome.value.reservationId;
  });

  it('T5 three releases of EUR 333,333.33 / 333,333.33 / 333,333.34 free exactly USD 1,100,000.00', async () => {
    const amounts = [33_333_333n, 33_333_333n, 33_333_334n];
    const freed: bigint[] = [];
    for (const [index, minor] of amounts.entries()) {
      const outcome = await release.execute(
        command({ releaseRef: `rel-${index}`, amount: { minor, currency: 'EUR' } }),
      );
      expect(outcome.ok).toBe(true);
      freed.push(world.state.ledger.at(-1)?.deltaReservedMinor ?? 0n);
    }
    expect(freed).toEqual([-36_666_666n, -36_666_666n, -36_666_668n]);
    expect(-freed.reduce((a, b) => a + b, 0n)).toBe(110_000_000n);
    expect(world.program('bank-a', 'grand-usd').reservedMinor).toBe(0n);
    expect([...world.state.reservations.values()][0]).toMatchObject({
      status: 'RELEASED',
      releasedMinor: 110_000_000n,
    });
    expect(world.state.outbox.filter((e) => e.type === 'ReservationReleased')).toHaveLength(3);
  });

  it('T5 an omitted amount releases the whole remainder and reports it', async () => {
    const outcome = await release.execute(command());
    expect(outcome).toMatchObject({
      ok: true,
      status: 200,
      value: {
        reservationStatus: 'RELEASED',
        invoiceAmount: { value: '1000000.00', currency: 'EUR' },
        releasedAmount: { value: '1100000.00', currency: 'USD' },
        remainingAmount: { value: '0.00', currency: 'USD' },
        capacity: { reserved: '0.00' },
      },
    });
  });

  it('T5 refuses a release above the remainder and leaves nothing behind, so the ref can be retried', async () => {
    const over = await release.execute(
      command({ amount: { minor: 100_000_001n, currency: 'EUR' } }),
    );
    expect(over).toMatchObject({
      ok: false,
      problem: { type: 'release-exceeds-remaining', status: 422 },
    });
    expect(world.state.releases).toHaveLength(0);
    expect(world.program('bank-a', 'grand-usd').reservedMinor).toBe(110_000_000n);
    const retry = await release.execute(
      command({ amount: { minor: 50_000_000n, currency: 'EUR' } }),
    );
    expect(retry).toMatchObject({ ok: true, value: { reservationStatus: 'PARTIALLY_RELEASED' } });
  });

  it('T5 replays the same release_ref with the same body and refuses a different one', async () => {
    const body = { amount: { minor: 25_000_000n, currency: 'EUR' } };
    const first = await release.execute(command(body));
    const reservedAfterFirst = world.program('bank-a', 'grand-usd').reservedMinor;
    const replay = await release.execute(command({ ...body, requestId: 'req-again' }));
    expect(replay).toEqual(first);
    expect(world.program('bank-a', 'grand-usd').reservedMinor).toBe(reservedAfterFirst);
    expect(world.state.ledger.filter((e) => e.kind === 'RELEASE')).toHaveLength(1);

    const differentAmount = await release.execute(
      command({ amount: { minor: 25_000_001n, currency: 'EUR' } }),
    );
    expect(differentAmount).toMatchObject({ ok: false, problem: { type: 'release-ref-mismatch' } });
    const differentReason = await release.execute(command({ ...body, reason: 'CANCELLED' }));
    expect(differentReason).toMatchObject({ ok: false, problem: { type: 'release-ref-mismatch' } });
    expect(world.program('bank-a', 'grand-usd').reservedMinor).toBe(reservedAfterFirst);
  });

  it('T5 refuses another currency, non-positive amounts, and unknown reservations', async () => {
    expect(
      await release.execute(command({ amount: { minor: 5n, currency: 'USD' } })),
    ).toMatchObject({ ok: false, problem: { type: 'validation-error' } });
    expect(
      await release.execute(command({ amount: { minor: 0n, currency: 'EUR' } })),
    ).toMatchObject({ ok: false, problem: { type: 'validation-error' } });
    expect(await release.execute(command({ reservationId: 'nope' }))).toMatchObject({
      ok: false,
      problem: { type: 'not-found', status: 404 },
    });
    expect(await release.execute(command({ tenantId: 'bank-b' }))).toMatchObject({
      ok: false,
      problem: { type: 'not-found' },
    });
    expect(world.state.releases).toHaveLength(0);
  });

  it('T5 stores the outcome under an Idempotency-Key and refuses the key with another body', async () => {
    const first = await release.execute(
      command({ idempotencyKey: 'RK', amount: { minor: 10_000_000n, currency: 'EUR' } }),
    );
    const second = await release.execute(
      command({ idempotencyKey: 'RK', amount: { minor: 10_000_000n, currency: 'EUR' } }),
    );
    expect(second).toEqual(first);
    const mismatch = await release.execute(
      command({ idempotencyKey: 'RK', amount: { minor: 10_000_001n, currency: 'EUR' } }),
    );
    expect(mismatch).toMatchObject({ ok: false, problem: { type: 'idempotency-key-mismatch' } });
    expect(world.state.ledger.filter((e) => e.kind === 'RELEASE')).toHaveLength(1);
  });

  it('T5 treats a finished reservation as having nothing left to release', async () => {
    await release.execute(command());
    const again = await release.execute(command({ releaseRef: 'rel-2' }));
    expect(again).toMatchObject({ ok: false, problem: { type: 'release-exceeds-remaining' } });
  });

  it('MINOR-3 a wrong amount currency is a validation error that never takes the key, so the corrected body reuses it', async () => {
    const wrong = await release.execute(
      command({ idempotencyKey: 'RK2', amount: { minor: 5n, currency: 'USD' } }),
    );
    expect(wrong).toMatchObject({ ok: false, problem: { type: 'validation-error', status: 400 } });
    expect(world.state.idempotency.size).toBe(0);
    expect(world.state.releases).toHaveLength(0);

    const fixed = await release.execute(
      command({ idempotencyKey: 'RK2', amount: { minor: 10_000_000n, currency: 'EUR' } }),
    );
    expect(fixed).toMatchObject({ ok: true, status: 200 });
    expect(world.state.idempotency.size).toBe(1);
  });
});
