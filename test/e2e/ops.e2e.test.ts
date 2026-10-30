import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { startApp, type RunningApp } from '#src/platform/bootstrap/start.js';
import { loadConfig } from '#src/platform/config/config.js';
import { createLogger } from '#src/platform/logging/logger.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

describe('ops endpoints', () => {
  let postgres: TestPostgres;
  let app: RunningApp;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    const config = loadConfig({
      APP_ROLE: 'api',
      HTTP_PORT: '0',
      OPS_PORT: '0',
      GRPC_PORT: '0',
      DATABASE_URL: postgres.url,
      KAFKA_BROKERS: 'localhost:9092',
      OAUTH_ISSUER: 'http://localhost:8081/default',
      OAUTH_AUDIENCE: 'capacity-service',
      OAUTH_JWKS_URL: 'http://localhost:8081/default/jwks',
      LOG_LEVEL: 'silent',
    });
    app = await startApp(config, createLogger('silent'));
  });

  afterAll(async () => {
    await app.close();
    await postgres.stop();
  });

  it('SK-04 serves /health/live, /health/ready with db up and Prometheus /metrics on the ops port', async () => {
    const ops = `http://127.0.0.1:${app.opsPort}`;

    const live = await fetch(`${ops}/health/live`);
    expect(live.status).toBe(200);

    const ready = await fetch(`${ops}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'up', db: 'up' });

    const metrics = await fetch(`${ops}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('# HELP process_cpu_user_seconds_total');
  });

  it('SK-04 does not serve ops endpoints on the business port', async () => {
    for (const path of ['/health/live', '/health/ready', '/metrics']) {
      const response = await fetch(`http://127.0.0.1:${app.httpPort ?? 0}${path}`);
      expect(response.status).toBe(404);
    }
  });

  it('SK-04 stops listening on close and close is idempotent', async () => {
    const ops = `http://127.0.0.1:${app.opsPort}`;
    const closing = app.close();
    await closing;
    await expect(fetch(`${ops}/health/live`)).rejects.toThrow();
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('SK-04 binds port 0 to a free port of its own and reports every bound port', async () => {
    // Why tests never pre-pick a port: a stand-in holds 127.0.0.1:<p>. Binding the wildcard
    // 0.0.0.0:<p> may still succeed (macOS), and then requests to 127.0.0.1:<p> reach the stand-in.
    const standIn = createServer((_request, response) => {
      response.end('not this service');
    });
    await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve));
    const address = standIn.address();
    const taken = typeof address === 'object' && address !== null ? address.port : 0;
    const settings = (httpPort: number) =>
      loadConfig({
        APP_ROLE: 'api',
        HTTP_PORT: String(httpPort),
        OPS_PORT: '0',
        GRPC_PORT: '0',
        DATABASE_URL: postgres.url,
        KAFKA_BROKERS: 'localhost:9092',
        OAUTH_ISSUER: 'http://localhost:8081/default',
        OAUTH_AUDIENCE: 'capacity-service',
        OAUTH_JWKS_URL: 'http://localhost:8081/default/jwks',
        LOG_LEVEL: 'silent',
      });
    try {
      // Old way: ask for the taken port. Either the bind fails (Linux) or it silently succeeds
      // and the "service" URL answers as the stand-in (macOS); both show pre-picking is unsafe.
      const outcome = await startApp(settings(taken), createLogger('silent')).then(
        async (clash) => {
          try {
            const text = await (await fetch(`http://127.0.0.1:${taken}/`)).text();
            return { bound: true as const, text };
          } finally {
            await clash.close();
          }
        },
        (error: unknown) => ({ bound: false as const, error }),
      );
      if (outcome.bound) expect(outcome.text).toBe('not this service');
      else expect(String(outcome.error)).toMatch(/EADDRINUSE/);

      // New way: port 0, the OS picks, RunningApp reports it, and it answers as this service.
      const fresh = await startApp(settings(0), createLogger('silent'));
      try {
        expect(fresh.httpPort).not.toBeNull();
        expect(fresh.httpPort).not.toBe(taken);
        expect(fresh.httpPort).toBeGreaterThan(0);
        expect(fresh.grpcPort).toBeGreaterThan(0);
        expect(fresh.opsPort).toBeGreaterThan(0);
        const response = await fetch(`http://127.0.0.1:${fresh.httpPort}/v1/programs/x/capacity`);
        expect(response.status).toBe(401);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
      } finally {
        await fresh.close();
      }
    } finally {
      await new Promise((resolve) => standIn.close(resolve));
    }
  });
});
