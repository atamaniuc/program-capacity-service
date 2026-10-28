import { createPersistence } from '../../src/capacity/adapters/out/postgres/db.js';
import { PostgresUnitOfWork } from '../../src/capacity/adapters/out/postgres/unit-of-work.js';
import { PostgresTreasuryUnitOfWork } from '../../src/capacity/adapters/out/postgres/treasury-unit-of-work.js';
import { systemClock, uuidV7Generator } from '../../src/capacity/adapters/out/system/system.js';
import {
  fxRatePublishedSchema,
  programLimitSetSchema,
} from '../../src/capacity/application/shared/treasury-messages.js';
import { ApplyTreasuryEvent } from '../../src/capacity/application/use-cases/apply-treasury-event/apply-treasury-event.js';
import { IngestFxRate } from '../../src/capacity/application/use-cases/ingest-fx-rate/ingest-fx-rate.js';
import { ReserveCapacity } from '../../src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import { formatMinor, parseMoney } from '../../src/capacity/domain/index.js';

/**
 * Deterministic seed (PRD §12): 3 tenants, 6 programs in USD, EUR, AED and KWD, current FX
 * rates and about 200 invoices. Programs and rates arrive as the treasury messages they would
 * be in production, and every invoice is reserved through the use case, so ledger and outbox
 * are consistent with the projection. Re-running is safe: messages and invoices deduplicate.
 */

const SEED = 20_261_028;
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://capacity:capacity@localhost:5432/capacity';

export interface SeedProgram {
  readonly tenantId: string;
  readonly id: string;
  readonly currency: string;
  readonly limit: string;
  readonly invoices: number;
}

export const SEED_PROGRAMS: readonly SeedProgram[] = [
  { tenantId: 'bank-a', id: 'prg_grand_usd', currency: 'USD', limit: '10000000.00', invoices: 40 },
  { tenantId: 'bank-a', id: 'prg_aegean_eur', currency: 'EUR', limit: '6000000.00', invoices: 30 },
  { tenantId: 'bank-b', id: 'prg_gulf_aed', currency: 'AED', limit: '40000000.00', invoices: 40 },
  { tenantId: 'bank-b', id: 'prg_kuwait_kwd', currency: 'KWD', limit: '3000000.000', invoices: 30 },
  { tenantId: 'bank-c', id: 'prg_atlas_usd', currency: 'USD', limit: '25000000.00', invoices: 35 },
  { tenantId: 'bank-c', id: 'prg_nordic_eur', currency: 'EUR', limit: '8000000.00', invoices: 25 },
];

const CURRENCIES = ['USD', 'EUR', 'AED', 'KWD'] as const;
/** Value of one unit in USD, scaled by 10^10 (current as of the seed). */
const USD_PER_UNIT: Readonly<Record<(typeof CURRENCIES)[number], bigint>> = {
  USD: 10_000_000_000n,
  EUR: 10_800_000_000n,
  AED: 2_722_940_000n,
  KWD: 32_500_000_000n,
};

/** mulberry32: a small seeded generator, so the same seed gives the same invoices. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rateString(from: (typeof CURRENCIES)[number], to: (typeof CURRENCIES)[number]): string {
  const scaled = (USD_PER_UNIT[from] * 10_000_000_000n) / USD_PER_UNIT[to];
  const digits = scaled.toString().padStart(11, '0');
  return `${digits.slice(0, -10)}.${digits.slice(-10)}`;
}

const source = (topic: string, offset: bigint) => ({
  consumer: topic === 'treasury.fx-rates.v1' ? 'treasury-fx' : 'treasury-capacity',
  topic,
  partition: 0,
  offset,
});

async function main(): Promise<void> {
  const persistence = createPersistence(DATABASE_URL, 4);
  const treasuryUow = new PostgresTreasuryUnitOfWork(persistence);
  const logger = { info: () => undefined, warn: () => undefined };
  const apply = new ApplyTreasuryEvent({ uow: treasuryUow, ids: uuidV7Generator, logger });
  const ingestFx = new IngestFxRate({ uow: treasuryUow, logger });
  const reserve = new ReserveCapacity({
    uow: new PostgresUnitOfWork(persistence),
    clock: systemClock,
    ids: uuidV7Generator,
    fxMaxAgeMs: 24 * 3600 * 1000,
  });
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const envelope = { schemaVersion: 1, occurredAt: now.toISOString() };

  try {
    for (const program of SEED_PROGRAMS) {
      await apply.execute(
        source('treasury.capacity.v1', 0n),
        programLimitSetSchema.parse({
          ...envelope,
          messageId: `seed-limit:${program.tenantId}:${program.id}`,
          type: 'ProgramLimitSet',
          tenantId: program.tenantId,
          programId: program.id,
          seq: 1,
          payload: { creditLimit: { value: program.limit, currency: program.currency } },
        }),
      );
    }

    let rates = 0;
    for (const base of CURRENCIES) {
      for (const quote of CURRENCIES) {
        if (base === quote) continue;
        const result = await ingestFx.execute(
          source('treasury.fx-rates.v1', 0n),
          fxRatePublishedSchema.parse({
            ...envelope,
            messageId: `seed-fx:${base}${quote}:${day}`,
            type: 'FxRatePublished',
            tenantId: '*',
            programId: '*',
            seq: Math.floor(now.getTime() / 1000),
            payload: {
              base,
              quote,
              rate: rateString(base, quote),
              asOf: now.toISOString(),
              source: 'seed',
            },
          }),
        );
        if (result.status === 'applied') rates += 1;
      }
    }

    const random = generator(SEED);
    let reserved = 0;
    let replayed = 0;
    let refused = 0;
    for (const program of SEED_PROGRAMS) {
      for (let index = 1; index <= program.invoices; index++) {
        // 60% of invoices are in the program currency, the rest in one of the others.
        const own = random() < 0.6;
        const others = CURRENCIES.filter((currency) => currency !== program.currency);
        const currency = own
          ? program.currency
          : (others[Math.floor(random() * others.length)] ?? 'USD');
        const whole = 20_000 + Math.floor(random() * 130_000);
        const parsed = parseMoney(
          formatMinor(BigInt(whole) * 10n ** BigInt(currency === 'KWD' ? 3 : 2), currency),
          currency,
        );
        if (!parsed.ok) throw new Error(`seed amount invalid: ${parsed.error}`);
        const outcome = await reserve.execute({
          tenantId: program.tenantId,
          actor: 'seed',
          requestId: `seed-${program.id}-${index}`,
          programId: program.id,
          invoiceId: `INV-${program.id.slice(4, 9).toUpperCase()}-${String(index).padStart(4, '0')}`,
          invoiceAmount: parsed.value,
        });
        if (!outcome.ok) refused += 1;
        else if (outcome.status === 201) reserved += 1;
        else replayed += 1;
      }
    }
    console.log(
      `seed: ${SEED_PROGRAMS.length} programs, ${rates} new FX rates, ${reserved} invoices reserved` +
        ` (${replayed} already there, ${refused} refused)`,
    );
  } finally {
    await persistence.close();
  }
}

await main();
