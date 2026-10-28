import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeRelease, type ReleaseState } from '#src/capacity/domain/index.js';

/** Splits `total` into positive parts using strictly increasing cut points. */
const splitOf = (total: bigint): fc.Arbitrary<bigint[]> =>
  total <= 1n
    ? fc.constant([total])
    : fc.uniqueArray(fc.bigInt({ min: 1n, max: total - 1n }), { maxLength: 12 }).map((cuts) => {
        const sorted = [...cuts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const points = [0n, ...sorted, total];
        return points.slice(1).map((point, index) => point - (points[index] as bigint));
      });

const scenario = fc
  .tuple(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 13n }))
  .chain(([invoice, program]) => splitOf(invoice).map((parts) => ({ invoice, program, parts })));

describe('release split', () => {
  it('AC-05 any split of the invoice amount into releases frees exactly the reserved amount', () => {
    fc.assert(
      fc.property(scenario, ({ invoice, program, parts }) => {
        let state: ReleaseState = {
          amountMinor: program,
          releasedMinor: 0n,
          invoiceAmountMinor: invoice,
          releasedInvoiceMinor: 0n,
        };
        let freed = 0n;
        for (const [index, part] of parts.entries()) {
          const result = computeRelease(state, part);
          if (!result.ok) throw new Error(`refused part ${part}`);
          const last = index === parts.length - 1;
          expect(result.value.completes).toBe(last);
          expect(result.value.status).toBe(last ? 'RELEASED' : 'PARTIALLY_RELEASED');
          if (!last) {
            // a partial release never frees more than its proportional share
            expect(result.value.programMinor).toBeLessThanOrEqual((program * part) / invoice);
            expect(result.value.programMinor).toBe((program * part) / invoice);
          }
          expect(result.value.programMinor).toBeGreaterThanOrEqual(0n);
          freed += result.value.programMinor;
          state = {
            ...state,
            releasedMinor: state.releasedMinor + result.value.programMinor,
            releasedInvoiceMinor: state.releasedInvoiceMinor + part,
          };
          // the remainder is never negative and never exceeds what is still reserved
          expect(state.releasedMinor).toBeLessThanOrEqual(program);
        }
        expect(freed).toBe(program);
        expect(state.releasedMinor).toBe(program);
      }),
      { numRuns: 500 },
    );
  });

  it('AC-05 a release above the remaining invoice amount is always refused and a zero release too', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 13n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        (invoice, program, extra) => {
          const state: ReleaseState = {
            amountMinor: program,
            releasedMinor: 0n,
            invoiceAmountMinor: invoice,
            releasedInvoiceMinor: 0n,
          };
          expect(computeRelease(state, invoice + extra)).toEqual({
            ok: false,
            error: 'exceeds-remaining',
          });
          expect(computeRelease(state, 0n)).toEqual({ ok: false, error: 'non-positive' });
          const whole = computeRelease(state, undefined);
          expect(whole).toMatchObject({
            ok: true,
            value: { programMinor: program, completes: true },
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});
