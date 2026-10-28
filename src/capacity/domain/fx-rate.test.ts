import { describe, expect, it } from 'vitest';
import { convertRoundingUp, formatFxRate, IDENTITY_RATE, parseFxRate } from './fx-rate.js';

describe('FxRate', () => {
  it('T2 parses and formats rates with ten decimal places', () => {
    expect(parseFxRate('1.08')).toEqual({ ok: true, value: { scaled: 10_800_000_000n } });
    expect(parseFxRate('0.0000000001')).toEqual({ ok: true, value: { scaled: 1n } });
    expect(formatFxRate({ scaled: 10_800_000_000n })).toBe('1.0800000000');
    expect(formatFxRate(IDENTITY_RATE)).toBe('1.0000000000');
    expect(formatFxRate({ scaled: 1n })).toBe('0.0000000001');
  });

  it('T2 refuses zero, negative, exponent and over-precise rates', () => {
    for (const bad of ['0', '0.0', '-1.1', '1e2', '1.00000000001', '', 'x']) {
      expect(parseFxRate(bad)).toEqual({ ok: false, error: 'malformed-rate' });
    }
  });

  it('T2 converts EUR 1,000,000.00 at 1.1 to exactly USD 1,100,000.00', () => {
    const rate = parseFxRate('1.1');
    if (!rate.ok) throw new Error('rate');
    const converted = convertRoundingUp(
      { minor: 100_000_000n, currency: 'EUR' },
      rate.value,
      'USD',
    );
    expect(converted).toEqual({ ok: true, value: { minor: 110_000_000n, currency: 'USD' } });
  });

  it('T2 rounds up to the program minor unit, never down', () => {
    // EUR 0.01 at 1.1 = USD 0.011 -> 0.02
    expect(
      convertRoundingUp({ minor: 1n, currency: 'EUR' }, { scaled: 11_000_000_000n }, 'USD'),
    ).toEqual({
      ok: true,
      value: { minor: 2n, currency: 'USD' },
    });
    // exact products are untouched
    expect(
      convertRoundingUp({ minor: 10n, currency: 'EUR' }, { scaled: 11_000_000_000n }, 'USD'),
    ).toEqual({
      ok: true,
      value: { minor: 11n, currency: 'USD' },
    });
  });

  it('T2 handles different scales (JPY 0, USD 2, KWD 3) and the identity rate', () => {
    // JPY 1000 at 0.0065 USD = USD 6.50 -> 650 cents
    expect(
      convertRoundingUp({ minor: 1000n, currency: 'JPY' }, { scaled: 65_000_000n }, 'USD'),
    ).toEqual({
      ok: true,
      value: { minor: 650n, currency: 'USD' },
    });
    // USD 1.00 at 0.3075 KWD = KWD 0.3075 -> 0.308
    expect(
      convertRoundingUp({ minor: 100n, currency: 'USD' }, { scaled: 3_075_000_000n }, 'KWD'),
    ).toEqual({
      ok: true,
      value: { minor: 308n, currency: 'KWD' },
    });
    // USD 1.01 at 150 JPY = 151.5 -> 152
    expect(
      convertRoundingUp({ minor: 101n, currency: 'USD' }, { scaled: 1_500_000_000_000n }, 'JPY'),
    ).toEqual({
      ok: true,
      value: { minor: 152n, currency: 'JPY' },
    });
    expect(convertRoundingUp({ minor: 12345n, currency: 'USD' }, IDENTITY_RATE, 'USD')).toEqual({
      ok: true,
      value: { minor: 12345n, currency: 'USD' },
    });
  });

  it('T2 refuses unsupported currencies', () => {
    expect(convertRoundingUp({ minor: 1n, currency: 'XXX' }, IDENTITY_RATE, 'USD')).toEqual({
      ok: false,
      error: 'unsupported-currency',
    });
    expect(convertRoundingUp({ minor: 1n, currency: 'USD' }, IDENTITY_RATE, 'XXX')).toEqual({
      ok: false,
      error: 'unsupported-currency',
    });
  });
});
