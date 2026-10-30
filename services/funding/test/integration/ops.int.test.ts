import { Registry } from 'prom-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPersistence } from '#src/funding/adapters/out/postgres/db.js';
import { migrate } from '#src/funding/adapters/out/postgres/migrate.js';
import { PostgresSagaStore } from '#src/funding/adapters/out/postgres/saga-store.js';
import { registerSagaMetrics } from '../../src/ops/metrics.js';
import { startOpsServer } from '../../src/ops/ops-server.js';
import { created } from '../support/fake-capacity.js';
import { startFundingPostgres, type FundingPostgres } from '../support/postgres.js';
import { startSagaWorld, type SagaWorld } from '../support/saga-world.js';

let world: SagaWorld;
let empty: FundingPostgres;

beforeAll(async () => {
  world = await startSagaWorld();
  empty = await startFundingPostgres();
});
afterAll(async () => {
  await world.close();
  await empty.stop();
});

describe('ops: readiness and saga metrics (api and worker)', () => {
  it('FS-18 readiness needs the database and the newest migration: not ready before migrate, ready after', async () => {
    const persistence = createPersistence(empty.fundingUrl);
    const store = new PostgresSagaStore(persistence);
    const ops = await startOpsServer({ port: 0, checks: { db: () => store.ping() } });
    const ready = async (): Promise<number> =>
      (await fetch(`http://127.0.0.1:${ops.port().toString()}/health/ready`)).status;
    try {
      expect(await ready()).toBe(503);
      await migrate(empty.fundingUrl);
      expect(await ready()).toBe(200);
      await persistence.pool.end().catch(() => undefined);
      await empty.stop();
      expect(await ready()).toBe(503);
    } finally {
      await ops.close();
    }
  });

  it('FS-18 /metrics shows requests per state, the oldest age per open state and step attempts by class', async () => {
    world.capacity.onReserve = () => created('res-metrics');
    world.rail.onDisburse = () => ({ kind: 'unknown' });
    const registry = new Registry();
    const metrics = registerSagaMetrics(registry, () => world.store.stats());
    const done = await world.submit({ invoiceId: 'inv-metrics-risk', value: '1000000.01' });
    const open = await world.submit({ invoiceId: 'inv-metrics-open' });
    const driver = world.driver({ hooks: { onRecorded: (c, t) => metrics.recorded(c, t) } });
    await driver.runOnce(); // risk for both
    await driver.runOnce(); // reserve for the open one
    expect((await world.row(done))['state']).toBe('REJECTED');
    expect((await world.row(open))['state']).toBe('DISBURSING');

    const text = await registry.metrics();
    expect(text).toMatch(/funding_requests\{state="REJECTED"\} 1/);
    expect(text).toMatch(/funding_requests\{state="DISBURSING"\} 1/);
    expect(text).toMatch(/funding_requests\{state="NEEDS_ATTENTION"\} 0/);
    expect(text).toMatch(/funding_oldest_request_age_seconds\{state="DISBURSING"\} \d/);
    expect(text).toMatch(/funding_step_attempts_total\{step="risk",class="failure"\} 1/);
    expect(text).toMatch(/funding_step_attempts_total\{step="reserve",class="success"\} 1/);
    expect(text).toMatch(/funding_requests_final_total\{state="REJECTED"\} 1/);
  });

  it('FS-18 a request parked NEEDS_ATTENTION is visible as a gauge; an unresolved reserve has an age', async () => {
    const registry = new Registry();
    registerSagaMetrics(registry, () => world.store.stats());
    const pool = new pg.Pool({ connectionString: world.postgres.fundingUrl, max: 1 });
    try {
      await pool.query(`
        INSERT INTO funding_request (tenant_id, program_id, invoice_id, currency, amount_minor, state,
                                     resolution_deadline_at, created_at, updated_at)
        VALUES ('bank-a', 'prg_1', 'inv-metrics-unresolved', 'USD', 100, 'COMPENSATING',
                now() + interval '1 hour', now() - interval '2 hours', now() - interval '2 hours'),
               ('bank-a', 'prg_1', 'inv-metrics-parked', 'USD', 100, 'NEEDS_ATTENTION',
                NULL, now(), now())`);
    } finally {
      await pool.end();
    }
    const text = await registry.metrics();
    expect(text).toMatch(/funding_requests\{state="NEEDS_ATTENTION"\} 1/);
    const unresolved = /funding_unresolved_reserve_oldest_age_seconds (\d+(?:\.\d+)?)/.exec(text);
    expect(Number(unresolved?.[1])).toBeGreaterThan(7000);
    expect(text).toMatch(/funding_oldest_request_age_seconds\{state="COMPENSATING"\} [1-9]/);
  });
});
