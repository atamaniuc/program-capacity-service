import { describe, expect, it } from 'vitest';
import { formatMoney, money, parseMoney } from './money.js';
import { assessRisk } from './risk.js';
import { DEFAULT_SAGA_CONFIG, backoffDelayMs, validateSagaConfig } from './config.js';
import { receiveFundingRequest } from './funding-request.js';

describe('money, risk policy and settings', () => {
  it('FS-01 money is bigint minor units in an ISO 4217 currency, parsed and formatted at the currency scale', () => {
    const parsed = parseMoney('1250.50', 'USD');
    expect(parsed).toEqual({ ok: true, value: { minor: 125_050n, currency: 'USD' } });
    expect(parseMoney('100', 'JPY')).toEqual({ ok: true, value: { minor: 100n, currency: 'JPY' } });
    expect(parseMoney('1.5', 'USD')).toEqual({ ok: false, error: 'wrong-scale' });
    expect(parseMoney('-1.00', 'USD')).toEqual({ ok: false, error: 'malformed-amount' });
    expect(parseMoney('1.00', 'XXX')).toEqual({ ok: false, error: 'unsupported-currency' });
    expect(parseMoney('0.00', 'USD')).toEqual({ ok: false, error: 'not-positive' });
    expect(money(9_223_372_036_854_775_808n, 'USD')).toEqual({
      ok: false,
      error: 'amount-too-large',
    });
    expect(parseMoney('92233720368547758.07', 'USD').ok).toBe(true);
    if (parsed.ok) expect(formatMoney(parsed.value)).toBe('1250.50');
    expect(formatMoney({ minor: 5n, currency: 'USD' })).toBe('0.05');
    expect(formatMoney({ minor: 1234n, currency: 'KWD' })).toBe('1.234');
  });

  it('FS-04 the risk policy declines above the per-currency limit and in a currency without one', () => {
    const policy = { limits: { USD: 1_000_000n, EUR: 500_000n } };
    expect(assessRisk({ minor: 1_000_000n, currency: 'USD' }, policy)).toEqual({ approved: true });
    expect(assessRisk({ minor: 1_000_001n, currency: 'USD' }, policy)).toEqual({
      approved: false,
      reason: 'risk-declined',
    });
    expect(assessRisk({ minor: 1n, currency: 'GBP' }, policy)).toEqual({
      approved: false,
      reason: 'risk-declined',
    });
    expect(assessRisk({ minor: 1n, currency: 'constructor' }, policy)).toEqual({
      approved: false,
      reason: 'risk-declined',
    });
  });

  it('FS-09 boot refuses a resolution limit that reaches capacity key retention', () => {
    expect(validateSagaConfig(DEFAULT_SAGA_CONFIG).ok).toBe(true);
    const day = 24 * 60 * 60 * 1000;
    expect(validateSagaConfig({ ...DEFAULT_SAGA_CONFIG, reserveResolutionLimitMs: day })).toEqual({
      ok: false,
      error: 'resolution-limit-reaches-key-retention',
    });
    expect(validateSagaConfig({ ...DEFAULT_SAGA_CONFIG, reserveDeadlineMs: 0 })).toEqual({
      ok: false,
      error: 'deadline-not-positive',
    });
    expect(validateSagaConfig({ ...DEFAULT_SAGA_CONFIG, reserveResolutionLimitMs: 1000 })).toEqual({
      ok: false,
      error: 'resolution-before-reserve-deadline',
    });
  });

  it('FS-11 backoff doubles from 0.5 s, caps at 60 s and jitters over the whole range', () => {
    expect(backoffDelayMs(0, 0.999)).toBe(499);
    expect(backoffDelayMs(1, 0.999)).toBe(999);
    expect(backoffDelayMs(7, 0.999)).toBe(59_940);
    expect(backoffDelayMs(1000, 0.999)).toBe(59_940);
    expect(backoffDelayMs(5, 0)).toBe(0);
  });

  it('FS-02 a funding request needs its identifiers', () => {
    const amount = { minor: 1n, currency: 'USD' };
    expect(
      receiveFundingRequest({ id: '', tenantId: 't', programId: 'p', invoiceId: 'i', amount }, 0),
    ).toEqual({ ok: false, error: 'missing-field' });
  });
});
