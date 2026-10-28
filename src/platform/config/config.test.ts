import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  APP_ROLE: 'api',
  DATABASE_URL: 'postgres://user:pw-secret-123@db:5432/capacity',
  KAFKA_BROKERS: 'kafka:9092',
  OAUTH_ISSUER: 'http://oauth:8080/default',
  OAUTH_AUDIENCE: 'capacity-service',
  OAUTH_JWKS_URL: 'http://oauth:8080/default/jwks',
};

describe('config', () => {
  it('SK-03 rejects a missing DATABASE_URL and names the field', () => {
    const env: Record<string, string> = { ...valid };
    delete env['DATABASE_URL'];
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('SK-03 rejects APP_ROLE=web, names the field and echoes no value', () => {
    let message = '';
    try {
      loadConfig({ ...valid, APP_ROLE: 'web' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/APP_ROLE/);
    expect(message).not.toContain('web');
  });

  it('SK-03 never prints the secret value of an invalid DATABASE_URL', () => {
    let message = '';
    try {
      loadConfig({ ...valid, DATABASE_URL: 'mysql://user:pw-secret-123@db/x' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('pw-secret-123');
  });

  it('SK-03 applies defaults and coerces ports', () => {
    const config = loadConfig({ ...valid, HTTP_PORT: '8080' });
    expect(config).toMatchObject({
      appRole: 'api',
      httpPort: 8080,
      opsPort: 9464,
      reconMode: 'HOLD',
      reconToleranceMinor: 1,
      reconMaxReservations: 50000,
      fxMaxAgeSeconds: 86400,
      logLevel: 'info',
      kafkaBrokers: ['kafka:9092'],
    });
  });

  it('SK-03 parses FX_MAX_AGE durations', () => {
    expect(loadConfig({ ...valid, FX_MAX_AGE: '15m' }).fxMaxAgeSeconds).toBe(900);
    expect(() => loadConfig({ ...valid, FX_MAX_AGE: 'soon' })).toThrow(/FX_MAX_AGE/);
  });

  it('SK-03 parses CORS_ORIGINS as a list of URLs and leaves CORS off by default', () => {
    expect(loadConfig(valid).corsOrigins).toEqual([]);
    expect(
      loadConfig({ ...valid, CORS_ORIGINS: 'http://localhost:9464, http://127.0.0.1:9464' })
        .corsOrigins,
    ).toEqual(['http://localhost:9464', 'http://127.0.0.1:9464']);
    expect(() => loadConfig({ ...valid, CORS_ORIGINS: 'not a url' })).toThrow(/CORS_ORIGINS/);
  });
});
