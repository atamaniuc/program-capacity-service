import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryWorld } from '../../../../../test/support/in-memory-ports.js';
import type { Program } from '../../../domain/index.js';
import { ReserveCapacity, type ReserveCapacityCommand } from './reserve-capacity.js';

const FX_MAX_AGE_MS = 24 * 3600 * 1000;

const usdProgram: Program = {
  tenantId: 'bank-a',
  id: 'grand-usd',
  currency: 'USD',
  creditLimitMinor: 1_000_000_000n,
  reservedMinor: 0n,
  status: 'ACTIVE',
  version: 0,
  treasurySeq: 0,
  platformSeq: 0,
};

function command(overrides: Partial<ReserveCapacityCommand> = {}): ReserveCapacityCommand {
  return {
    tenantId: 'bank-a',
    actor: 'svc-orders',
    requestId: 'req-1',
    programId: 'grand-usd',
    invoiceId: 'INV-1',
    invoiceAmount: { minor: 100_000_000n, currency: 'USD' },
    ...overrides,
  };
}

describe('ReserveCapacity', () => {
  let world: InMemoryWorld;
  let reserve: ReserveCapacity;

  beforeEach(() => {
    world = new InMemoryWorld();
    world.addProgram(usdProgram);
    reserve = new ReserveCapacity({
      uow: world,
      clock: world.clock,
      ids: world.ids,
      fxMaxAgeMs: FX_MAX_AGE_MS,
    });
  });

  it('T4 creates a same-currency reservation at rate 1 with ledger and outbox rows', async () => {
    const outcome = await reserve.execute(command());
    expect(outcome).toMatchObject({
      ok: true,
      status: 201,
      value: {
        status: 'ACTIVE',
        invoiceAmount: { value: '1000000.00', currency: 'USD' },
        reservedAmount: { value: '1000000.00', currency: 'USD' },
        fx: { rate: '1.0000000000', source: 'identity' },
        capacity: {
          limit: '10000000.00',
          reserved: '1000000.00',
          available: '9000000.00',
          version: 1,
        },
      },
    });
    expect(world.program('bank-a', 'grand-usd')).toMatchObject({
      reservedMinor: 100_000_000n,
      platformSeq: 1,
    });
    expect(world.state.ledger).toEqual([
      expect.objectContaining({
        kind: 'RESERVE',
        deltaReservedMinor: 100_000_000n,
        reservedAfter: 100_000_000n,
        limitAfter: 1_000_000_000n,
        causeType: 'http',
        causeId: 'req-1',
        actor: 'svc-orders',
      }),
    ]);
    expect(world.state.outbox).toEqual([
      expect.objectContaining({ type: 'ReservationCreated', programSeq: 1 }),
    ]);
  });

  it('T4 converts a foreign-currency invoice with the newest valid rate, rounding up', async () => {
    world.addFx('EUR', 'USD', 10_000_000_000n, new Date('2026-10-28T08:00:00Z'));
    world.addFx('EUR', 'USD', 10_800_000_001n, new Date('2026-10-28T09:00:00Z'), 'treasury-live');
    const outcome = await reserve.execute(
      command({ invoiceAmount: { minor: 100_000_000n, currency: 'EUR' } }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      status: 201,
      value: {
        reservedAmount: { value: '1080000.01', currency: 'USD' },
        fx: { rate: '1.0800000001', source: 'treasury-live', asOf: '2026-10-28T09:00:00.000Z' },
      },
    });
  });

  it('T4 rejects when no FX rate is younger than the maximum age', async () => {
    world.addFx('EUR', 'USD', 10_800_000_000n, new Date('2026-10-27T09:59:59Z'));
    const outcome = await reserve.execute(
      command({ invoiceAmount: { minor: 100n, currency: 'EUR' } }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      problem: { type: 'fx-rate-unavailable', status: 422 },
    });
    expect(world.state.reservations.size).toBe(0);
  });

  it('T4 rejects an amount above the available capacity and changes nothing', async () => {
    const outcome = await reserve.execute(
      command({ invoiceAmount: { minor: 1_000_000_001n, currency: 'USD' } }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      problem: { type: 'insufficient-capacity', status: 422 },
    });
    expect(world.program('bank-a', 'grand-usd').reservedMinor).toBe(0n);
    expect(world.state.ledger).toHaveLength(0);
  });

  it('T4 admits an amount equal to the available capacity', async () => {
    const outcome = await reserve.execute(
      command({ invoiceAmount: { minor: 1_000_000_000n, currency: 'USD' } }),
    );
    expect(outcome).toMatchObject({ ok: true, status: 201 });
  });

  it('T4 rejects suspended and over-limit programs', async () => {
    world.addProgram({ ...usdProgram, status: 'SUSPENDED' });
    expect(await reserve.execute(command())).toMatchObject({
      ok: false,
      problem: { type: 'program-suspended' },
    });
    world.addProgram({ ...usdProgram, creditLimitMinor: 100n, reservedMinor: 200n });
    expect(await reserve.execute(command())).toMatchObject({
      ok: false,
      problem: { type: 'program-over-limit' },
    });
  });

  it('T4 answers 404 for an unknown program and 400 for a non-positive amount', async () => {
    expect(await reserve.execute(command({ programId: 'nope' }))).toMatchObject({
      ok: false,
      problem: { type: 'not-found', status: 404 },
    });
    expect(
      await reserve.execute(command({ invoiceAmount: { minor: 0n, currency: 'USD' } })),
    ).toMatchObject({ ok: false, problem: { type: 'validation-error', status: 400 } });
  });

  it('T4 rejects an unsupported invoice currency without touching the program', async () => {
    world.addFx('XXX', 'USD', 10_000_000_000n, new Date('2026-10-28T09:00:00Z'));
    const outcome = await reserve.execute(
      command({ invoiceAmount: { minor: 100n, currency: 'XXX' } }),
    );
    expect(outcome).toMatchObject({ ok: false, problem: { type: 'validation-error' } });
  });

  it('T4 replays the same terms with 200 and refuses different terms or a released invoice with 409', async () => {
    await reserve.execute(command());
    const again = await reserve.execute(command());
    expect(again).toMatchObject({ ok: true, status: 200, value: { invoiceId: 'INV-1' } });
    expect(world.state.reservations.size).toBe(1);
    expect(world.program('bank-a', 'grand-usd').reservedMinor).toBe(100_000_000n);

    const different = await reserve.execute(
      command({ invoiceAmount: { minor: 100_000_001n, currency: 'USD' } }),
    );
    expect(different).toMatchObject({
      ok: false,
      problem: { type: 'reservation-conflict', status: 409 },
    });

    const [reservation] = [...world.state.reservations.values()];
    world.state.reservations.set(reservation!.id, {
      ...reservation!,
      status: 'RELEASED',
      releasedMinor: reservation!.amountMinor,
      releasedInvoiceMinor: reservation!.invoiceAmount.minor,
    });
    expect(await reserve.execute(command())).toMatchObject({
      ok: false,
      problem: { type: 'reservation-conflict' },
    });
  });

  it('T4 stores the first outcome under the key and replays it, including rejections', async () => {
    const first = await reserve.execute(command({ idempotencyKey: 'K1' }));
    const second = await reserve.execute(command({ idempotencyKey: 'K1', requestId: 'req-2' }));
    expect(second).toEqual(first);
    expect(world.state.ledger).toHaveLength(1);
    expect(world.state.ledger[0]?.causeId).toBe('K1');

    const big = command({
      idempotencyKey: 'K2',
      invoiceId: 'INV-2',
      invoiceAmount: { minor: 2_000_000_000n, currency: 'USD' },
    });
    const rejected = await reserve.execute(big);
    expect(rejected).toMatchObject({ ok: false, problem: { type: 'insufficient-capacity' } });
    world.addProgram({ ...world.program('bank-a', 'grand-usd'), creditLimitMinor: 9_000_000_000n });
    expect(await reserve.execute(big)).toEqual(rejected);
  });

  it('T4 refuses a key reused with a different body and stores nothing for it', async () => {
    await reserve.execute(command({ idempotencyKey: 'K1' }));
    const outcome = await reserve.execute(
      command({ idempotencyKey: 'K1', invoiceAmount: { minor: 5n, currency: 'USD' } }),
    );
    expect(outcome).toMatchObject({
      ok: false,
      problem: { type: 'idempotency-key-mismatch', status: 422 },
    });
    expect(world.state.reservations.size).toBe(1);
  });

  it('T4 rolls back on an infrastructure error, including the claimed key', async () => {
    world.state.ledger.push = () => {
      throw new Error('disk full');
    };
    await expect(reserve.execute(command({ idempotencyKey: 'K9' }))).rejects.toThrow('disk full');
    expect(world.state.idempotency.size).toBe(0);
    expect(world.state.reservations.size).toBe(0);
    expect(world.program('bank-a', 'grand-usd').reservedMinor).toBe(0n);
  });
});
