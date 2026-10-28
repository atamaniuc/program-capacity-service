import { describe, expect, it } from 'vitest';
import { InMemoryWorld } from '../../../../../test/support/in-memory-ports.js';
import { ReleaseReservation } from '../release-reservation/release-reservation.js';
import { ReserveCapacity } from '../reserve-capacity/reserve-capacity.js';
import { GetCapacity } from './get-capacity/get-capacity.js';
import { GetReservation } from './get-reservation/get-reservation.js';

describe('queries', () => {
  async function seeded(): Promise<{ world: InMemoryWorld; reservationId: string }> {
    const world = new InMemoryWorld();
    world.addProgram({
      tenantId: 'bank-a',
      id: 'p1',
      currency: 'USD',
      creditLimitMinor: 1_000_000n,
      reservedMinor: 0n,
      status: 'ACTIVE',
      version: 0,
      treasurySeq: 7,
      platformSeq: 0,
    });
    const reserve = new ReserveCapacity({
      uow: world,
      clock: world.clock,
      ids: world.ids,
      fxMaxAgeMs: 1000,
    });
    const outcome = await reserve.execute({
      tenantId: 'bank-a',
      actor: 'a',
      requestId: 'r',
      programId: 'p1',
      invoiceId: 'INV',
      invoiceAmount: { minor: 400_000n, currency: 'USD' },
    });
    if (!outcome.ok) throw new Error('setup');
    return { world, reservationId: outcome.value.reservationId };
  }

  it('FR-01 reports limit, reserved, available, overLimitBy, utilization, version and treasurySeq', async () => {
    const { world } = await seeded();
    const outcome = await new GetCapacity(world).execute({ tenantId: 'bank-a', programId: 'p1' });
    expect(outcome).toEqual({
      ok: true,
      status: 200,
      value: {
        programId: 'p1',
        currency: 'USD',
        limit: '10000.00',
        reserved: '4000.00',
        available: '6000.00',
        overLimitBy: '0.00',
        utilization: '0.4000',
        version: 1,
        treasurySeq: 7,
      },
    });
  });

  it('FR-01 answers 404 for another tenant or an unknown program', async () => {
    const { world } = await seeded();
    const getCapacity = new GetCapacity(world);
    expect(await getCapacity.execute({ tenantId: 'bank-b', programId: 'p1' })).toMatchObject({
      ok: false,
      problem: { type: 'not-found' },
    });
    expect(await getCapacity.execute({ tenantId: 'bank-a', programId: 'zz' })).toMatchObject({
      ok: false,
    });
  });

  it('FR-01 returns a reservation with its releases and hides it from other tenants', async () => {
    const { world, reservationId } = await seeded();
    await new ReleaseReservation({ uow: world, clock: world.clock, ids: world.ids }).execute({
      tenantId: 'bank-a',
      actor: 'a',
      requestId: 'r',
      programId: 'p1',
      reservationId,
      releaseRef: 'rel',
      reason: 'CANCELLED',
      amount: { minor: 100_000n, currency: 'USD' },
    });
    const getReservation = new GetReservation(world);
    const outcome = await getReservation.execute({
      tenantId: 'bank-a',
      programId: 'p1',
      reservationId,
    });
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        status: 'PARTIALLY_RELEASED',
        remainingAmount: { value: '3000.00' },
        releases: [
          {
            releaseRef: 'rel',
            reason: 'CANCELLED',
            invoiceAmount: { value: '1000.00', currency: 'USD' },
            releasedAmount: { value: '1000.00', currency: 'USD' },
          },
        ],
      },
    });
    for (const query of [
      { tenantId: 'bank-b', programId: 'p1', reservationId },
      { tenantId: 'bank-a', programId: 'p1', reservationId: 'unknown' },
      { tenantId: 'bank-a', programId: 'other', reservationId },
    ]) {
      expect(await getReservation.execute(query)).toMatchObject({
        ok: false,
        problem: { type: 'not-found' },
      });
    }
    world.addProgram({ ...world.program('bank-a', 'p1'), id: 'other' });
    expect(
      await getReservation.execute({ tenantId: 'bank-a', programId: 'other', reservationId }),
    ).toMatchObject({ ok: false, problem: { type: 'not-found' } });
  });
});
