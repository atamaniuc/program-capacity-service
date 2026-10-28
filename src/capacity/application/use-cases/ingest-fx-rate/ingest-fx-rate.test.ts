import { describe, expect, it } from 'vitest';
import { InMemoryTreasuryWorld } from '../../../../../test/kafka/support/in-memory-treasury.js';
import { fxRatePublishedSchema } from '../../shared/treasury-messages.js';
import { IngestFxRate } from './ingest-fx-rate.js';

const SOURCE = { consumer: 'treasury-fx', topic: 'treasury.fx-rates.v1', partition: 0, offset: 1n };

const message = (payload: Record<string, unknown>, messageId = 'fx-1') =>
  fxRatePublishedSchema.parse({
    messageId,
    type: 'FxRatePublished',
    schemaVersion: 1,
    tenantId: '*',
    programId: '*',
    seq: 1,
    occurredAt: '2026-10-28T10:00:00Z',
    payload: {
      base: 'EUR',
      quote: 'USD',
      rate: '1.0800000000',
      asOf: '2026-10-28T09:00:00Z',
      source: 'treasury',
      ...payload,
    },
  });

describe('ingest fx rate', () => {
  it('AC-12 stores a rate once and skips a redelivery', async () => {
    const world = new InMemoryTreasuryWorld();
    const ingest = new IngestFxRate({
      uow: world,
      logger: { info: () => undefined, warn: () => undefined },
    });
    expect((await ingest.execute(SOURCE, message({}))).status).toBe('applied');
    expect((await ingest.execute(SOURCE, message({}))).status).toBe('duplicate');
    expect(world.state.fxRates).toHaveLength(1);
    expect(world.state.fxRates[0]?.rate.scaled).toBe(10_800_000_000n);
  });

  it('refuses an unsupported currency', async () => {
    const world = new InMemoryTreasuryWorld();
    const ingest = new IngestFxRate({
      uow: world,
      logger: { info: () => undefined, warn: () => undefined },
    });
    await expect(ingest.execute(SOURCE, message({ base: 'ZZZ' }, 'fx-2'))).rejects.toMatchObject({
      code: 'schema-invalid',
    });
    expect(() => message({ rate: '0' })).toThrow();
  });
});
