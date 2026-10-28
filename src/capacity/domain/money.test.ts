import { describe, expect, it } from 'vitest';
import { formatMinor, formatMoney, parseMoney } from './money.js';

describe('Money', () => {
  it('T2 parses decimal strings at the currency scale into minor units', () => {
    expect(parseMoney('1250.50', 'USD')).toEqual({
      ok: true,
      value: { minor: 125050n, currency: 'USD' },
    });
    expect(parseMoney('100', 'JPY')).toEqual({ ok: true, value: { minor: 100n, currency: 'JPY' } });
    expect(parseMoney('1.234', 'KWD')).toEqual({
      ok: true,
      value: { minor: 1234n, currency: 'KWD' },
    });
    expect(parseMoney('0.00', 'EUR')).toEqual({ ok: true, value: { minor: 0n, currency: 'EUR' } });
    expect(parseMoney('90071992547409930000.01', 'USD')).toEqual({
      ok: true,
      value: { minor: 9007199254740993000001n, currency: 'USD' },
    });
  });

  it('T2 refuses wrong scale, signs, exponents, separators and unknown currencies', () => {
    expect(parseMoney('1250.5', 'USD')).toEqual({ ok: false, error: 'wrong-scale' });
    expect(parseMoney('1250.500', 'USD')).toEqual({ ok: false, error: 'wrong-scale' });
    expect(parseMoney('1250', 'USD')).toEqual({ ok: false, error: 'wrong-scale' });
    expect(parseMoney('100.0', 'JPY')).toEqual({ ok: false, error: 'wrong-scale' });
    for (const bad of [
      '-1.00',
      '+1.00',
      '1e3',
      '1,000.00',
      ' 1.00',
      '1.00 ',
      '',
      '.50',
      '01.00',
      'abc',
    ]) {
      expect(parseMoney(bad, 'USD')).toEqual({ ok: false, error: 'malformed-amount' });
    }
    expect(parseMoney('1.00', 'XXX')).toEqual({ ok: false, error: 'unsupported-currency' });
    expect(parseMoney('1.00', 'constructor')).toEqual({ ok: false, error: 'unsupported-currency' });
  });

  it('T2 formats minor units back to exact decimal strings', () => {
    expect(formatMinor(125050n, 'USD')).toBe('1250.50');
    expect(formatMinor(5n, 'USD')).toBe('0.05');
    expect(formatMinor(0n, 'USD')).toBe('0.00');
    expect(formatMinor(100n, 'JPY')).toBe('100');
    expect(formatMinor(1234n, 'KWD')).toBe('1.234');
    expect(formatMinor(-1234n, 'KWD')).toBe('-1.234');
    expect(formatMoney({ minor: 110000000n, currency: 'USD' })).toBe('1100000.00');
    expect(() => formatMinor(1n, 'XXX')).toThrow(/unsupported currency/);
  });
});
