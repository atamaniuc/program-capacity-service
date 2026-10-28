import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresTreasuryUnitOfWork } from '#src/capacity/adapters/out/postgres/treasury-unit-of-work.js';
import {
  fxRatePublishedSchema,
  type FxRatePublished,
} from '#src/capacity/application/shared/treasury-messages.js';
import { IngestFxRate } from '#src/capacity/application/use-cases/ingest-fx-rate/ingest-fx-rate.js';
import { fxRate } from '../../tools/simulator/messages.js';
import {
  count,
  programRow,
  seedProgram,
  startCapacityWorld,
  type CapacityWorld,
} from '../support/capacity-world.js';

const SOURCE = { consumer: 'treasury-fx', topic: 'treasury.fx-rates.v1', partition: 0 };
const HOUR = 3_600_000;

describe('fx rates', () => {
  let world: CapacityWorld;
  let ingest: IngestFxRate;
  let offset = 0n;
  let invoiceCounter = 0;

  const publish = (
    pair: { base: string; quote: string; rate: string; asOf: Date },
    messageId?: string,
  ) =>
    ingest.execute(
      { ...SOURCE, offset: ++offset },
      fxRatePublishedSchema.parse(
        JSON.parse(fxRate(pair, messageId === undefined ? {} : { messageId }).value),
      ) satisfies FxRatePublished,
    );

  const reserveEur = (programId: string) =>
    world.reserve.execute({
      tenantId: 'bank-a',
      actor: 'svc-orders',
      requestId: 'req',
      programId,
      invoiceId: `INV-${++invoiceCounter}`,
      invoiceAmount: { minor: 1_000_000n, currency: 'EUR' },
    });

  beforeAll(async () => {
    world = await startCapacityWorld({ fxMaxAgeMs: 24 * HOUR });
    ingest = new IngestFxRate({
      uow: new PostgresTreasuryUnitOfWork(world.persistence),
      logger: { info: () => undefined, warn: () => undefined },
    });
    await seedProgram(world, {
      tenantId: 'bank-a',
      id: 'usd-program',
      limitMinor: 100_000_000_000n,
    });
  });

  afterAll(async () => {
    await world.close();
  });

  it('AC-12 answers 422 fx-rate-unavailable and reserves nothing when the newest rate is older than the max age', async () => {
    await publish({
      base: 'EUR',
      quote: 'USD',
      rate: '1.0800000000',
      asOf: new Date(Date.now() - 30 * HOUR),
    });

    const outcome = await reserveEur('usd-program');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problem.type).toBe('fx-rate-unavailable');
      expect(outcome.problem.status).toBe(422);
    }
    expect(await count(world, 'reservation')).toBe(0);
    expect((await programRow(world, 'bank-a', 'usd-program')).reserved_minor).toBe('0');
  });

  it('AC-12 reserves with a fresh rate once treasury publishes one, and stores it on the reservation', async () => {
    await publish({
      base: 'EUR',
      quote: 'USD',
      rate: '1.1000000000',
      asOf: new Date(Date.now() - HOUR),
    });

    const outcome = await reserveEur('usd-program');

    expect(outcome.ok && outcome.value.fx.rate).toBe('1.1000000000');
    expect(outcome.ok && outcome.value.reservedAmount.value).toBe('11000.00');
  });

  it('AC-12 keeps the newer rate when an older one arrives late', async () => {
    await publish({
      base: 'EUR',
      quote: 'USD',
      rate: '1.2000000000',
      asOf: new Date(Date.now() - 10 * 60_000),
    });
    await publish({
      base: 'EUR',
      quote: 'USD',
      rate: '0.5000000000',
      asOf: new Date(Date.now() - 5 * HOUR),
    });

    const outcome = await reserveEur('usd-program');

    expect(outcome.ok && outcome.value.fx.rate).toBe('1.2000000000');
  });

  it('AC-10 ignores a redelivered rate message', async () => {
    const rate = {
      base: 'GBP',
      quote: 'USD',
      rate: '1.3000000000',
      asOf: new Date(Date.now() - HOUR),
    };
    expect((await publish(rate, 'fx-dup')).status).toBe('applied');
    expect((await publish(rate, 'fx-dup')).status).toBe('duplicate');
    expect(await count(world, 'fx_rate', "base = 'GBP'")).toBe(1);
  });
});
