import { afterEach, describe, expect, it } from 'vitest';
import { Registry } from 'prom-client';
import { loopAlive, registerSagaMetrics } from '../../src/ops/metrics.js';
import { startOpsServer, type OpsServer } from '../../src/ops/ops-server.js';

let server: OpsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const get = async (path: string, method = 'GET') => {
  const response = await fetch(`http://127.0.0.1:${server!.port().toString()}${path}`, { method });
  return { status: response.status, text: await response.text() };
};

describe('ops server (api and worker, port 9464 in the images)', () => {
  it('FS-18 /health/live is up without checking anything', async () => {
    server = await startOpsServer({
      port: 0,
      checks: { db: () => Promise.reject(new Error('down')) },
    });
    expect((await get('/health/live')).status).toBe(200);
  });

  it('FS-18 /health/ready is 200 only when every check is up, 503 naming the one that is down', async () => {
    let dbUp = true;
    server = await startOpsServer({
      port: 0,
      checks: {
        db: () => (dbUp ? Promise.resolve() : Promise.reject(new Error('db down'))),
        loop: () => Promise.resolve(),
      },
    });
    const up = await get('/health/ready');
    expect(up.status).toBe(200);
    expect(JSON.parse(up.text)).toEqual({ status: 'up', db: 'up', loop: 'up' });
    dbUp = false;
    const down = await get('/health/ready');
    expect(down.status).toBe(503);
    expect(JSON.parse(down.text)).toEqual({ status: 'down', db: 'down', loop: 'up' });
  });

  it('FS-18 draining flips readiness to 503 while liveness stays up', async () => {
    server = await startOpsServer({ port: 0, checks: {} });
    expect((await get('/health/ready')).status).toBe(200);
    server.markDraining();
    expect((await get('/health/ready')).status).toBe(503);
    expect((await get('/health/live')).status).toBe(200);
  });

  it('FS-18 /metrics serves the registry; other methods and paths are refused', async () => {
    const registry = new Registry();
    server = await startOpsServer({ port: 0, checks: {}, registry });
    expect((await get('/metrics')).text).toContain('process_cpu_user_seconds_total');
    expect((await get('/health/live', 'POST')).status).toBe(405);
    expect((await get('/nope')).status).toBe(404);
  });

  it('FS-18 a worker whose driver loop stopped ticking is not ready', async () => {
    let now = 1_000;
    const metrics = registerSagaMetrics(new Registry(), () =>
      Promise.resolve({
        counts: new Map(),
        oldestAgeSeconds: new Map(),
        oldestUnresolvedReserveAgeSeconds: 0,
      }),
    );
    const alive = loopAlive({ lastHeartbeatMs: () => 1_000 }, 60_000, () => now);
    await expect(alive()).resolves.toBeUndefined();
    now = 1_000 + 60_001;
    await expect(alive()).rejects.toThrow(/stalled/);
    metrics.heartbeat();
    expect(metrics.lastHeartbeatMs()).toBeGreaterThan(0);
  });
});
