import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { startApp, type RunningApp } from '#src/platform/bootstrap/start.js';
import { loadConfig } from '#src/platform/config/config.js';
import { createLogger } from '#src/platform/logging/logger.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

describe('ops endpoints', () => {
  let postgres: TestPostgres;
  let app: RunningApp;
  let httpPort: number;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    httpPort = await freePort();
    const config = loadConfig({
      APP_ROLE: 'api',
      HTTP_PORT: String(httpPort),
      OPS_PORT: String(await freePort()),
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
      const response = await fetch(`http://127.0.0.1:${httpPort}${path}`);
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
});
