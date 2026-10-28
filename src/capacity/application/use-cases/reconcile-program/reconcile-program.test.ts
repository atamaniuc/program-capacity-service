import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTreasuryWorld } from '../../../../../test/kafka/support/in-memory-treasury.js';
import { programReconciledSchema } from '../../shared/treasury-messages.js';
import { ReserveCapacity } from '../reserve-capacity/reserve-capacity.js';
import { MAX_DRIFTS_IN_EVENT, ReconcileProgram } from './reconcile-program.js';

const SOURCE = {
  consumer: 'treasury-capacity',
  topic: 'treasury.capacity.v1',
  partition: 0,
  offset: 1n,
};
const usd = (value: string) => ({ value, currency: 'USD' });

function snapshot(seq: number, payload: Record<string, unknown>, programId = 'prg') {
  return programReconciledSchema.parse({
    messageId: `snap-${programId}-${seq}`,
    type: 'ProgramReconciled',
    schemaVersion: 1,
    tenantId: 'bank-a',
    programId,
    seq,
    occurredAt: '2026-10-28T10:00:00Z',
    payload: { asOf: '2026-10-28T10:00:00Z', creditLimit: usd('1000000.00'), ...payload },
  });
}

describe('reconcile program', () => {
  let world: InMemoryTreasuryWorld;
  let events: string[];
  let betweenPlanAndLock: (() => Promise<void>) | undefined;
  let reconcile: ReconcileProgram;

  beforeEach(() => {
    world = new InMemoryTreasuryWorld();
    events = [];
    betweenPlanAndLock = undefined;
    world.addProgram({
      tenantId: 'bank-a',
      id: 'prg',
      currency: 'USD',
      creditLimitMinor: 100_000_000n,
      reservedMinor: 0n,
      status: 'ACTIVE',
      version: 0,
      treasurySeq: 0,
      platformSeq: 0,
    });
    reconcile = new ReconcileProgram({
      uow: world,
      clock: world.clock,
      ids: world.ids,
      logger: {
        info: (fields) => events.push(String(fields['event'])),
        warn: (fields) => events.push(String(fields['event'])),
      },
      policy: { toleranceMinor: 1n, mode: 'HOLD', skewMs: 300_000 },
      maxReservations: 3,
      betweenPlanAndLock: () => betweenPlanAndLock?.() ?? Promise.resolve(),
    });
  });

  async function reserve(invoiceId: string, minor: bigint) {
    const reserveCapacity = new ReserveCapacity({
      uow: world,
      clock: world.clock,
      ids: world.ids,
      fxMaxAgeMs: 1,
    });
    const outcome = await reserveCapacity.execute({
      tenantId: 'bank-a',
      actor: 'a',
      requestId: 'r',
      programId: 'prg',
      invoiceId,
      invoiceAmount: { minor, currency: 'USD' },
    });
    if (!outcome.ok) throw new Error(outcome.problem.type);
  }

  it('AC-14 AC-15 logs within-tolerance, adjusts the rest, applies the limit, and keeps I1', async () => {
    await reserve('A', 100_000n);
    await reserve('B', 200_000n);
    const result = await reconcile.execute(
      SOURCE,
      snapshot(3, {
        platformWatermark: 2,
        creditLimit: usd('2000000.00'),
        reservations: [
          {
            invoiceId: 'A',
            outstandingInvoiceAmount: usd('1000.00'),
            outstandingReservedAmount: usd('1000.01'),
          },
          {
            invoiceId: 'B',
            outstandingInvoiceAmount: usd('1500.00'),
            outstandingReservedAmount: usd('1500.00'),
          },
          {
            invoiceId: 'C',
            outstandingInvoiceAmount: usd('50.00'),
            outstandingReservedAmount: usd('50.00'),
          },
        ],
      }),
    );
    expect(result.status).toBe('applied');
    expect(events.filter((e) => e === 'within-tolerance')).toHaveLength(1);
    const program = world.program('bank-a', 'prg');
    expect(program).toMatchObject({
      creditLimitMinor: 200_000_000n,
      reservedMinor: 100_000n + 150_000n + 5_000n,
      treasurySeq: 3,
    });
    const open = [...world.state.reservations.values()].reduce(
      (sum, r) => sum + r.amountMinor - r.releasedMinor,
      0n,
    );
    expect(open).toBe(program.reservedMinor);
    expect(world.state.ledger.map((e) => e.kind).slice(2)).toEqual([
      'LIMIT_SET',
      'RECON_ADJUST',
      'RECON_ADJUST',
    ]);
    expect(world.state.ledger.at(-1)?.reservedAfter).toBe(program.reservedMinor);
    expect(world.state.outbox.map((e) => e.type).slice(2)).toEqual([
      'ProgramCapacityChanged',
      'ReconciliationDriftDetected',
    ]);
    expect([...world.state.reservations.values()].find((r) => r.invoiceId === 'C')?.origin).toBe(
      'TREASURY',
    );
  });

  it('AC-08 caps the drift list in ReconciliationDriftDetected and reports the total', async () => {
    const big = new ReconcileProgram({
      uow: world,
      clock: world.clock,
      ids: world.ids,
      logger: { info: () => undefined, warn: () => undefined },
      policy: { toleranceMinor: 1n, mode: 'HOLD', skewMs: 300_000 },
      maxReservations: 500,
    });
    const reservations = Array.from({ length: 150 }, (_, index) => ({
      invoiceId: `INV-${index}`,
      outstandingInvoiceAmount: usd('1.00'),
      outstandingReservedAmount: usd('1.00'),
    }));
    expect(
      (await big.execute(SOURCE, snapshot(1, { platformWatermark: 0, reservations }))).status,
    ).toBe('applied');
    const event = world.state.outbox.find((e) => e.type === 'ReconciliationDriftDetected');
    const payload = event?.payload as { drifts: unknown[]; driftCount: number; truncated: boolean };
    expect(MAX_DRIFTS_IN_EVENT).toBe(100);
    expect(payload.drifts).toHaveLength(100);
    expect(payload.driftCount).toBe(150);
    expect(payload.truncated).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThan(100_000);
  });

  it('AC-08 holds a seen reservation, logs the fallback, and only records the seq when nothing changes', async () => {
    await reserve('A', 100_000n);
    const held = await reconcile.execute(
      SOURCE,
      snapshot(1, { platformWatermark: 5, creditLimit: usd('1000000.00'), reservations: [] }),
    );
    expect(held.status).toBe('applied');
    expect(world.program('bank-a', 'prg').reservedMinor).toBe(100_000n);
    expect(world.state.outbox.map((e) => e.type)).toContain('ReconciliationDriftDetected');

    const quiet = await reconcile.execute(
      SOURCE,
      snapshot(2, { platformWatermark: 0, creditLimit: usd('1000000.00'), reservations: [] }),
    );
    expect(quiet.status).toBe('applied');
    expect(world.program('bank-a', 'prg').treasurySeq).toBe(2);
    await reconcile.execute(
      SOURCE,
      snapshot(3, { creditLimit: usd('1000000.00'), reservations: [] }),
    );
    expect(events).toContain('reconciliation_fallback');
  });

  it('AC-08 recomputes when the program moved between planning and the lock', async () => {
    await reserve('A', 100_000n);
    betweenPlanAndLock = () => reserve('LATE', 50_000n);
    const result = await reconcile.execute(
      SOURCE,
      snapshot(1, {
        platformWatermark: 1,
        reservations: [
          {
            invoiceId: 'A',
            outstandingInvoiceAmount: usd('1000.00'),
            outstandingReservedAmount: usd('1000.00'),
          },
        ],
      }),
    );
    expect(result.status === 'applied' && result.recomputed).toBe(true);
    expect(world.program('bank-a', 'prg').reservedMinor).toBe(150_000n);
  });

  it('AC-09 AC-10 skips a stale snapshot and a duplicate one', async () => {
    const message = snapshot(4, { platformWatermark: 0, reservations: [] });
    expect((await reconcile.execute(SOURCE, message)).status).toBe('applied');
    expect((await reconcile.execute(SOURCE, message)).status).toBe('duplicate');
    expect(await reconcile.execute(SOURCE, snapshot(2, { reservations: [] }))).toEqual({
      status: 'stale',
      treasurySeq: 4,
    });
    expect(events).toEqual(['duplicate-skipped', 'stale-skipped']);
  });

  it('AC-09 skips a stale snapshot even when its payload is invalid', async () => {
    await reconcile.execute(SOURCE, snapshot(4, { reservations: [] }));
    const entry = (invoiceId: string) => ({
      invoiceId,
      outstandingInvoiceAmount: usd('1.00'),
      outstandingReservedAmount: usd('1.00'),
    });
    await expect(
      reconcile.execute(SOURCE, snapshot(2, { reservations: [entry('1'), entry('1')] })),
    ).resolves.toEqual({ status: 'stale', treasurySeq: 4 });
  });

  it('parks snapshots that can never apply', async () => {
    const entry = (invoiceId: string, value = '1.00') => ({
      invoiceId,
      outstandingInvoiceAmount: usd(value),
      outstandingReservedAmount: usd(value),
    });
    const code = (message: ReturnType<typeof snapshot>) =>
      reconcile.execute(SOURCE, message).then(
        () => 'applied',
        (error: { code: string }) => error.code,
      );
    expect(
      await code(snapshot(1, { reservations: [entry('1'), entry('2'), entry('3'), entry('4')] })),
    ).toBe('snapshot-too-large');
    expect(await code(snapshot(1, { reservations: [entry('1'), entry('1')] }))).toBe(
      'invalid-snapshot',
    );
    expect(await code(snapshot(1, { reservations: [entry('1', '0.00')] }))).toBe(
      'invalid-snapshot',
    );
    expect(await code(snapshot(1, { reservations: [] }, 'missing'))).toBe('unknown-program');
    expect(
      await code(
        snapshot(1, { creditLimit: { value: '1.00', currency: 'EUR' }, reservations: [] }),
      ),
    ).toBe('currency-mismatch');
    await reserve('A', 100_000n);
    const euro = {
      invoiceId: 'A',
      outstandingInvoiceAmount: { value: '10.00', currency: 'EUR' },
      outstandingReservedAmount: usd('10.00'),
    };
    expect(await code(snapshot(1, { reservations: [euro] }))).toBe('invalid-snapshot');
  });
});
