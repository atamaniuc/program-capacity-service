import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, parseDuration } from '../../src/worker-config.js';

const BASE = {
  DATABASE_URL: 'postgres://funding:funding@localhost/funding',
  CAPACITY_GRPC_TARGET: 'localhost:50051',
  OAUTH_TOKEN_URL: 'http://localhost:8080/default/token',
  PAYMENTS_BASE_URL: 'http://localhost:3200',
};

describe('worker config (boot validation, ADR 025)', () => {
  it('FS-09 the defaults are the ADR table and validate', () => {
    const config = loadWorkerConfig(BASE);
    expect(config.saga).toEqual({
      reserveDeadlineMs: 120_000,
      disburseDeadlineMs: 900_000,
      reserveResolutionLimitMs: 43_200_000,
    });
    expect(config.grpcDeadlineMs).toBe(21_000);
    expect(config.leaseMs).toBe(30_000);
  });

  it('FS-09 a resolution limit that reaches the 24 h key retention stops the boot', () => {
    expect(() => loadWorkerConfig({ ...BASE, FUNDING_RESERVE_RESOLUTION_LIMIT: '24h' })).toThrow(
      /resolution-limit-reaches-key-retention/,
    );
    expect(() =>
      loadWorkerConfig({ ...BASE, FUNDING_RESERVE_RESOLUTION_LIMIT: '23h' }),
    ).not.toThrow();
  });

  it('FS-09 a resolution limit below the reserve deadline stops the boot', () => {
    expect(() =>
      loadWorkerConfig({
        ...BASE,
        FUNDING_RESERVE_DEADLINE: '10m',
        FUNDING_RESERVE_RESOLUTION_LIMIT: '5m',
      }),
    ).toThrow(/resolution-before-reserve-deadline/);
  });

  it('FS-12 a lease that does not outlast one call, or a call deadline inside capacity timeouts, stops the boot', () => {
    expect(() => loadWorkerConfig({ ...BASE, FUNDING_STEP_LEASE: '20s' })).toThrow(
      /FUNDING_STEP_LEASE/,
    );
    expect(() => loadWorkerConfig({ ...BASE, FUNDING_GRPC_DEADLINE_MS: '20000' })).toThrow(
      /FUNDING_GRPC_DEADLINE_MS/,
    );
  });

  it('FS-04 risk limits are parsed as minor units per currency; garbage stops the boot', () => {
    expect(
      loadWorkerConfig({ ...BASE, FUNDING_RISK_LIMITS: 'USD=500,EUR=900' }).risk.limits,
    ).toEqual({
      USD: 500n,
      EUR: 900n,
    });
    expect(() => loadWorkerConfig({ ...BASE, FUNDING_RISK_LIMITS: 'USD=-1' })).toThrow(/CCC=/);
  });

  it('FS-09 durations take ms, s, m, h and refuse anything else', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('250')).toBe(250);
    expect(parseDuration('2 days')).toBeUndefined();
    expect(() => loadWorkerConfig({ ...BASE, FUNDING_RESERVE_DEADLINE: 'soon' })).toThrow(
      /not a duration/,
    );
  });
});
