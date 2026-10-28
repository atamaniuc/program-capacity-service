import { TOPIC_CAPACITY } from '../../src/capacity/application/shared/treasury-messages.js';
import {
  fxRate,
  limitSet,
  repayment,
  snapshot,
  type Amount,
  type ProducedMessage,
  type SnapshotReservationJson,
} from './messages.js';

export const SCENARIO_NAMES = [
  'limit-cut',
  'repayments',
  'late-snapshot',
  'duplicate-delivery',
  'out-of-order',
  'poison-message',
  'fx-stale',
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** What a scenario needs to know about the program it plays against. */
export interface ScenarioContext {
  readonly tenantId: string;
  readonly programId: string;
  readonly currency: string;
  /** First sequence number to use; the program's treasury_seq must be below it. */
  readonly seq: number;
  readonly now: Date;
  readonly invoiceId: string;
  readonly invoiceAmount: Amount;
  /** Reservations treasury knows at snapshot time (late-snapshot). */
  readonly known: readonly SnapshotReservationJson[];
  readonly platformWatermark: number;
  readonly newLimit: string;
  /** Currency pair for fx-stale. */
  readonly fxPair: { base: string; quote: string };
}

export function defaultContext(overrides: Partial<ScenarioContext> = {}): ScenarioContext {
  return {
    tenantId: 'bank-a',
    programId: 'prg_demo',
    currency: 'USD',
    seq: Math.floor(Date.now() / 1000),
    now: new Date(),
    invoiceId: 'INV-DEMO-1',
    invoiceAmount: { value: '1000000.00', currency: 'USD' },
    known: [],
    platformWatermark: 0,
    newLimit: '3000000.00',
    fxPair: { base: 'GBP', quote: 'KWD' },
    ...overrides,
  };
}

function at(context: ScenarioContext, offset: number) {
  return { tenantId: context.tenantId, programId: context.programId, seq: context.seq + offset };
}

const SCENARIOS: Readonly<Record<ScenarioName, (c: ScenarioContext) => ProducedMessage[]>> = {
  /** A treasury cut below what is reserved: the program goes over limit (AC-07). */
  'limit-cut': (c) => [limitSet(at(c, 0), { value: c.newLimit, currency: c.currency })],

  /** Two repayments of one invoice: a partial one, then the rest (FR-03 through Kafka). */
  repayments: (c) => {
    const half = halve(c.invoiceAmount);
    return [
      repayment(at(c, 0), {
        invoiceId: c.invoiceId,
        releaseRef: `${c.invoiceId}-pay-1`,
        amount: half,
      }),
      repayment(at(c, 1), {
        invoiceId: c.invoiceId,
        releaseRef: `${c.invoiceId}-pay-2`,
        amount: { value: subtract(c.invoiceAmount, half), currency: c.invoiceAmount.currency },
      }),
    ];
  },

  /** A snapshot taken before the platform's newest reservation: it must survive (AC-08). */
  'late-snapshot': (c) => [
    snapshot(at(c, 0), {
      asOf: c.now,
      creditLimit: { value: '10000000.00', currency: c.currency },
      platformWatermark: c.platformWatermark,
      reservations: c.known,
    }),
  ],

  /** The same message twice: one effect (AC-10). */
  'duplicate-delivery': (c) => {
    const message = limitSet(at(c, 0), { value: c.newLimit, currency: c.currency });
    return [message, message];
  },

  /** Seq n+1 arrives before seq n: the late one is skipped (AC-09). */
  'out-of-order': (c) => [
    limitSet(at(c, 1), { value: c.newLimit, currency: c.currency }),
    limitSet(at(c, 0), { value: '1.00', currency: c.currency }),
  ],

  /** Two records that can never be applied, then a good one behind them (AC-11). */
  'poison-message': (c) => {
    const good = limitSet(at(c, 0), { value: c.newLimit, currency: c.currency });
    return [
      { topic: TOPIC_CAPACITY, key: good.key, value: '{"this is": not json' },
      {
        topic: TOPIC_CAPACITY,
        key: good.key,
        value: JSON.stringify({ messageId: 'bad', type: 'ProgramLimitSet' }),
      },
      good,
    ];
  },

  /** A rate three days old: the newest rate is older than FX_MAX_AGE (AC-12). */
  'fx-stale': (c) => [
    fxRate({
      ...c.fxPair,
      rate: '0.3950000000',
      asOf: new Date(c.now.getTime() - 3 * 24 * 3600 * 1000),
    }),
  ],
};

export function buildScenario(name: ScenarioName, context: ScenarioContext): ProducedMessage[] {
  return SCENARIOS[name](context);
}

/** Half of an amount, rounded down to the currency's minor unit (decimal strings, no floats). */
function halve(amount: Amount): Amount {
  const digits = amount.value.replace('.', '');
  const scale = amount.value.includes('.')
    ? amount.value.length - amount.value.indexOf('.') - 1
    : 0;
  return { value: fromMinor(BigInt(digits) / 2n, scale), currency: amount.currency };
}

function subtract(total: Amount, part: Amount): string {
  const scale = total.value.includes('.') ? total.value.length - total.value.indexOf('.') - 1 : 0;
  return fromMinor(
    BigInt(total.value.replace('.', '')) - BigInt(part.value.replace('.', '')),
    scale,
  );
}

function fromMinor(minor: bigint, scale: number): string {
  if (scale === 0) return minor.toString();
  const digits = minor.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
}
