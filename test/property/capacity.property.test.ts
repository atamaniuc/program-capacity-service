import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import { InMemoryWorld } from '../support/in-memory-ports.js';

type Op =
  | { kind: 'reserve'; invoice: number; minor: bigint; currency: 'USD' | 'EUR'; key: number | null }
  | { kind: 'release'; reservation: number; fraction: number; ref: number; whole: boolean }
  | { kind: 'limit'; limitMinor: bigint };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('reserve' as const),
    invoice: fc.integer({ min: 0, max: 7 }),
    minor: fc.bigInt({ min: 1n, max: 400_000n }),
    currency: fc.constantFrom('USD' as const, 'EUR' as const),
    key: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  }),
  fc.record({
    kind: fc.constant('release' as const),
    reservation: fc.integer({ min: 0, max: 7 }),
    fraction: fc.integer({ min: 1, max: 100 }),
    ref: fc.integer({ min: 0, max: 5 }),
    whole: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('limit' as const),
    limitMinor: fc.bigInt({ min: 0n, max: 3_000_000n }),
  }),
);

describe('capacity invariants', () => {
  it('I1-I5 and I7 hold after every step of random reserve, release and limit-cut sequences', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 40 }), async (ops) => {
        const world = new InMemoryWorld();
        const initialLimit = 1_000_000n;
        world.addProgram({
          tenantId: 't',
          id: 'p',
          currency: 'USD',
          creditLimitMinor: initialLimit,
          reservedMinor: 0n,
          status: 'ACTIVE',
          version: 0,
          treasurySeq: 0,
          platformSeq: 0,
        });
        world.addFx('EUR', 'USD', 10_800_000_000n, new Date('2026-10-28T09:00:00Z'));
        const reserve = new ReserveCapacity({
          uow: world,
          clock: world.clock,
          ids: world.ids,
          fxMaxAgeMs: 24 * 3600 * 1000,
        });
        const release = new ReleaseReservation({ uow: world, clock: world.clock, ids: world.ids });
        let lastVersion = 0;

        for (const step of ops) {
          const before = world.program('t', 'p');
          if (step.kind === 'reserve') {
            const outcome = await reserve.execute({
              tenantId: 't',
              actor: 'a',
              requestId: 'r',
              programId: 'p',
              invoiceId: `INV-${step.invoice}`,
              invoiceAmount: { minor: step.minor, currency: step.currency },
              ...(step.key === null ? {} : { idempotencyKey: `K${step.key}` }),
            });
            if (outcome.ok && outcome.status === 201) {
              // I2: it committed only because the program was ACTIVE with enough capacity
              expect(before.status).toBe('ACTIVE');
              const created = [...world.state.reservations.values()].find(
                (r) => r.id === outcome.value.reservationId,
              );
              expect(before.creditLimitMinor - before.reservedMinor).toBeGreaterThanOrEqual(
                created?.amountMinor ?? 0n,
              );
            }
          } else if (step.kind === 'release') {
            const reservations = [...world.state.reservations.values()];
            const target = reservations[step.reservation % Math.max(reservations.length, 1)];
            if (target !== undefined) {
              const remainingInvoice = target.invoiceAmount.minor - target.releasedInvoiceMinor;
              const minor = (remainingInvoice * BigInt(step.fraction)) / 100n;
              await release.execute({
                tenantId: 't',
                actor: 'a',
                requestId: 'r',
                programId: 'p',
                reservationId: target.id,
                releaseRef: `ref-${step.ref}`,
                reason: 'REPAID',
                ...(step.whole || minor <= 0n
                  ? {}
                  : { amount: { minor, currency: target.invoiceAmount.currency } }),
              });
            }
          } else {
            // a treasury limit event, applied the way the consumer lane will: ledger + version
            const delta = step.limitMinor - before.creditLimitMinor;
            world.addProgram({
              ...before,
              creditLimitMinor: step.limitMinor,
              version: before.version + 1,
              treasurySeq: before.treasurySeq + 1,
            });
            world.state.ledger.push({
              tenantId: 't',
              programId: 'p',
              reservationId: null,
              kind: 'LIMIT_SET',
              deltaReservedMinor: 0n,
              deltaLimitMinor: delta,
              limitAfter: step.limitMinor,
              reservedAfter: before.reservedMinor,
              causeType: 'kafka',
              causeId: 'm',
              actor: 'treasury',
            });
          }

          const program = world.program('t', 'p');
          const reservations = [...world.state.reservations.values()];

          // I1: reserved = sum of what open reservations still hold
          const open = reservations
            .filter((r) => r.status !== 'RELEASED')
            .reduce((sum, r) => sum + (r.amountMinor - r.releasedMinor), 0n);
          expect(program.reservedMinor).toBe(open);
          expect(program.reservedMinor).toBeGreaterThanOrEqual(0n);

          // I3: 0 <= released <= amount and the status follows from the numbers
          for (const r of reservations) {
            expect(r.releasedMinor).toBeGreaterThanOrEqual(0n);
            expect(r.releasedMinor).toBeLessThanOrEqual(r.amountMinor);
            expect(r.releasedInvoiceMinor).toBeLessThanOrEqual(r.invoiceAmount.minor);
            expect(r.status === 'RELEASED').toBe(r.releasedInvoiceMinor === r.invoiceAmount.minor);
            if (r.status === 'RELEASED') expect(r.releasedMinor).toBe(r.amountMinor);
            if (r.status === 'ACTIVE') expect(r.releasedInvoiceMinor).toBe(0n);
          }

          // I4: one reservation per invoice, one release per (reservation, release_ref)
          const invoices = reservations.map((r) => r.invoiceId);
          expect(new Set(invoices).size).toBe(invoices.length);
          const refs = world.state.releases.map((r) => `${r.reservationId}/${r.releaseRef}`);
          expect(new Set(refs).size).toBe(refs.length);

          // I5: ledger sums reproduce the projection
          const reservedFromLedger = world.state.ledger.reduce(
            (sum, e) => sum + e.deltaReservedMinor,
            0n,
          );
          const limitFromLedger =
            initialLimit + world.state.ledger.reduce((sum, e) => sum + e.deltaLimitMinor, 0n);
          expect(reservedFromLedger).toBe(program.reservedMinor);
          expect(limitFromLedger).toBe(program.creditLimitMinor);
          const last = world.state.ledger.at(-1);
          if (last !== undefined) {
            expect(last.reservedAfter).toBe(program.reservedMinor);
            expect(last.limitAfter).toBe(program.creditLimitMinor);
          }

          // I7: version only grows
          expect(program.version).toBeGreaterThanOrEqual(lastVersion);
          lastVersion = program.version;
        }
      }),
      { numRuns: 200 },
    );
  });
});
