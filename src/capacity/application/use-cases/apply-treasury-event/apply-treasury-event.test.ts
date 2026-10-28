import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTreasuryWorld } from '../../../../../test/kafka/support/in-memory-treasury.js';
import { PermanentError, type TreasuryLogger } from '../../shared/treasury-errors.js';
import { assertSupportedCurrency, moneyOf } from '../../shared/treasury-messages.js';
import { programLimitSetSchema, repaymentReceivedSchema } from '../../shared/treasury-messages.js';
import { ReserveCapacity } from '../reserve-capacity/reserve-capacity.js';
import { ApplyTreasuryEvent } from './apply-treasury-event.js';

const SOURCE = {
  consumer: 'treasury-capacity',
  topic: 'treasury.capacity.v1',
  partition: 0,
  offset: 1n,
};

function limitSet(
  seq: number,
  value: string,
  extra: Record<string, unknown> = {},
  currency = 'USD',
) {
  return programLimitSetSchema.parse({
    messageId: `ls-${seq}-${value}`,
    type: 'ProgramLimitSet',
    schemaVersion: 1,
    tenantId: 'bank-a',
    programId: 'prg',
    seq,
    occurredAt: '2026-10-28T10:00:00Z',
    payload: { creditLimit: { value, currency }, ...extra },
  });
}

function repayment(seq: number, releaseRef: string, value: string, id = `rp-${releaseRef}`) {
  return repaymentReceivedSchema.parse({
    messageId: id,
    type: 'RepaymentReceived',
    schemaVersion: 1,
    tenantId: 'bank-a',
    programId: 'prg',
    seq,
    occurredAt: '2026-10-28T10:00:00Z',
    payload: { invoiceId: 'INV-1', releaseRef, amount: { value, currency: 'EUR' } },
  });
}

describe('apply treasury event', () => {
  let world: InMemoryTreasuryWorld;
  let apply: ApplyTreasuryEvent;
  let logs: string[];

  beforeEach(() => {
    world = new InMemoryTreasuryWorld();
    logs = [];
    const logger: TreasuryLogger = {
      info: (fields) => logs.push(String(fields['event'])),
      warn: (fields) => logs.push(String(fields['event'])),
    };
    apply = new ApplyTreasuryEvent({ uow: world, ids: world.ids, logger });
  });

  async function reserveEur(value = 100_000n) {
    const reserve = new ReserveCapacity({
      uow: world,
      clock: world.clock,
      ids: world.ids,
      fxMaxAgeMs: 86_400_000,
    });
    const outcome = await reserve.execute({
      tenantId: 'bank-a',
      actor: 'a',
      requestId: 'r',
      programId: 'prg',
      invoiceId: 'INV-1',
      invoiceAmount: { minor: value, currency: 'EUR' },
    });
    if (!outcome.ok) throw new Error(outcome.problem.type);
  }

  it('AC-07 creates a missing program ACTIVE, then a cut below reserved makes it over limit', async () => {
    expect((await apply.execute(SOURCE, limitSet(1, '10000000.00'))).status).toBe('applied');
    expect(world.program('bank-a', 'prg')).toMatchObject({
      status: 'ACTIVE',
      creditLimitMinor: 1_000_000_000n,
      treasurySeq: 1,
    });

    world.addFx('EUR', 'USD', 11_000_000_000n, new Date(world.now.getTime() - 1000));
    await reserveEur(300_000_000n);
    await apply.execute(SOURCE, limitSet(2, '3000000.00', { status: 'SUSPENDED' }));

    const program = world.program('bank-a', 'prg');
    expect(program).toMatchObject({
      creditLimitMinor: 300_000_000n,
      reservedMinor: 330_000_000n,
      status: 'SUSPENDED',
    });
    expect(
      world.state.ledger.filter((e) => e.kind === 'LIMIT_SET').map((e) => e.deltaLimitMinor),
    ).toEqual([1_000_000_000n, -700_000_000n]);
    expect(world.state.outbox.filter((e) => e.type === 'ProgramCapacityChanged')).toHaveLength(2);
  });

  it("AC-16 sets the limit only on the message tenant's program when another tenant uses the same program id", async () => {
    const otherTenant = programLimitSetSchema.parse({
      messageId: 'ls-bank-b',
      type: 'ProgramLimitSet',
      schemaVersion: 1,
      tenantId: 'bank-b',
      programId: 'prg',
      seq: 1,
      occurredAt: '2026-10-28T10:00:00Z',
      payload: { creditLimit: { value: '100.00', currency: 'USD' } },
    });
    expect((await apply.execute(SOURCE, otherTenant)).status).toBe('applied');

    expect((await apply.execute(SOURCE, limitSet(1, '200.00'))).status).toBe('applied');
    expect(world.program('bank-a', 'prg').creditLimitMinor).toBe(20_000n);
    expect(world.program('bank-b', 'prg').creditLimitMinor).toBe(10_000n);
  });

  it('AC-09 and AC-10 skip a stale seq and a redelivered message without changing anything', async () => {
    await apply.execute(SOURCE, limitSet(5, '100.00'));
    const ledger = world.state.ledger.length;
    expect(await apply.execute(SOURCE, limitSet(5, '200.00'))).toEqual({
      status: 'stale',
      treasurySeq: 5,
    });
    expect(await apply.execute(SOURCE, limitSet(4, '300.00'))).toEqual({
      status: 'stale',
      treasurySeq: 5,
    });
    expect((await apply.execute(SOURCE, limitSet(5, '100.00'))).status).toBe('duplicate');
    expect(world.state.ledger).toHaveLength(ledger);
    expect(world.program('bank-a', 'prg').creditLimitMinor).toBe(10_000n);
    expect(logs).toEqual(['stale-skipped', 'stale-skipped', 'duplicate-skipped']);
  });

  it('refuses a limit in another currency than the program', async () => {
    await apply.execute(SOURCE, limitSet(1, '100.00'));
    await expect(apply.execute(SOURCE, limitSet(2, '100.00', {}, 'EUR'))).rejects.toMatchObject({
      code: 'currency-mismatch',
    });
  });

  it('repays an invoice in two releases through the shared release path', async () => {
    await apply.execute(SOURCE, limitSet(1, '10000000.00'));
    world.addFx('EUR', 'USD', 11_000_000_000n, new Date(world.now.getTime() - 1000));
    await reserveEur(100_000n);
    expect(world.program('bank-a', 'prg').reservedMinor).toBe(110_000n);

    expect((await apply.execute(SOURCE, repayment(2, 'pay-1', '400.00'))).status).toBe('applied');
    expect(world.program('bank-a', 'prg')).toMatchObject({
      reservedMinor: 66_000n,
      treasurySeq: 2,
    });
    expect((await apply.execute(SOURCE, repayment(3, 'pay-2', '600.00'))).status).toBe('applied');
    expect(world.program('bank-a', 'prg').reservedMinor).toBe(0n);

    const releases = world.state.ledger.filter((e) => e.kind === 'RELEASE');
    expect(releases.map((e) => e.causeType)).toEqual(['kafka', 'kafka']);
    expect(world.state.outbox.filter((e) => e.type === 'ReservationReleased')).toHaveLength(2);
    // The same release_ref under a new message id replays the stored result: no second effect.
    expect((await apply.execute(SOURCE, repayment(4, 'pay-2', '600.00', 'again'))).status).toBe(
      'applied',
    );
    expect(world.program('bank-a', 'prg').reservedMinor).toBe(0n);
  });

  it('parks a repayment that cannot be applied and leaves no trace of it', async () => {
    await apply.execute(SOURCE, limitSet(1, '10000000.00'));
    await expect(apply.execute(SOURCE, repayment(2, 'pay-x', '1.00'))).rejects.toMatchObject({
      code: 'unknown-reservation',
    });
    expect(world.inbox.has('treasury-capacity/rp-pay-x')).toBe(false);

    world.addFx('EUR', 'USD', 11_000_000_000n, new Date(world.now.getTime() - 1000));
    await reserveEur(100_000n);
    await expect(apply.execute(SOURCE, repayment(2, 'pay-big', '1001.00'))).rejects.toMatchObject({
      code: 'release-rejected',
    });
    const usd = repaymentReceivedSchema.parse({
      ...repayment(2, 'pay-usd', '1.00'),
      payload: {
        invoiceId: 'INV-1',
        releaseRef: 'pay-usd',
        amount: { value: '1.00', currency: 'USD' },
      },
    });
    await expect(apply.execute(SOURCE, usd)).rejects.toMatchObject({ code: 'release-rejected' });
    expect(world.program('bank-a', 'prg').treasurySeq).toBe(1);
  });

  it('skips a stale repayment before looking for its reservation', async () => {
    await apply.execute(SOURCE, limitSet(9, '100.00'));
    expect(await apply.execute(SOURCE, repayment(3, 'old', '1.00'))).toEqual({
      status: 'stale',
      treasurySeq: 9,
    });
    const missing = repaymentReceivedSchema.parse({
      ...repayment(10, 'x', '1.00'),
      programId: 'nope',
    });
    await expect(apply.execute(SOURCE, missing)).rejects.toBeInstanceOf(PermanentError);
  });

  it('validates money in the message contracts', () => {
    expect(moneyOf({ value: '1.50', currency: 'USD' })).toEqual({ minor: 150n, currency: 'USD' });
    expect(() => moneyOf({ value: '1.5', currency: 'USD' })).toThrow(PermanentError);
    expect(() => assertSupportedCurrency('ZZZ')).toThrow(PermanentError);
    expect(() => assertSupportedCurrency('USD')).not.toThrow();
    expect(() => limitSet(1, '1.555')).toThrow();
  });
});
