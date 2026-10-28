import { describe, expect, it } from 'vitest';
import { computeRelease, type ReleaseState } from './release.js';

const fresh: ReleaseState = {
  amountMinor: 110_000_000n,
  releasedMinor: 0n,
  invoiceAmountMinor: 100_000_000n,
  releasedInvoiceMinor: 0n,
};

describe('computeRelease', () => {
  it('T2 frees the floored proportional share for a partial release', () => {
    const result = computeRelease(fresh, 33_333_333n);
    expect(result).toEqual({
      ok: true,
      value: {
        invoiceMinor: 33_333_333n,
        programMinor: 36_666_666n,
        completes: false,
        status: 'PARTIALLY_RELEASED',
      },
    });
  });

  it('T2 takes the exact remainder on the release that completes the invoice', () => {
    const state: ReleaseState = {
      ...fresh,
      releasedMinor: 73_333_332n,
      releasedInvoiceMinor: 66_666_666n,
    };
    const result = computeRelease(state, 33_333_334n);
    expect(result).toEqual({
      ok: true,
      value: {
        invoiceMinor: 33_333_334n,
        programMinor: 36_666_668n,
        completes: true,
        status: 'RELEASED',
      },
    });
  });

  it('T2 treats an omitted amount as the whole remainder', () => {
    const state: ReleaseState = { ...fresh, releasedMinor: 11n, releasedInvoiceMinor: 10n };
    const result = computeRelease(state, undefined);
    expect(result).toMatchObject({
      ok: true,
      value: { invoiceMinor: 99_999_990n, programMinor: 109_999_989n, completes: true },
    });
  });

  it('T2 refuses a release above the remaining invoice amount, zero, and a finished reservation', () => {
    expect(computeRelease(fresh, 100_000_001n)).toEqual({ ok: false, error: 'exceeds-remaining' });
    expect(computeRelease(fresh, 0n)).toEqual({ ok: false, error: 'non-positive' });
    const done: ReleaseState = {
      ...fresh,
      releasedMinor: fresh.amountMinor,
      releasedInvoiceMinor: fresh.invoiceAmountMinor,
    };
    expect(computeRelease(done, 1n)).toEqual({ ok: false, error: 'exceeds-remaining' });
    expect(computeRelease(done, undefined)).toEqual({ ok: false, error: 'exceeds-remaining' });
  });
});
