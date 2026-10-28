import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPersistence } from '#src/capacity/adapters/out/postgres/db.js';
import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

describe('migrations', () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
  });

  afterAll(async () => {
    await postgres.stop();
  });

  it('SK-05 applies baseline once, the second run is a no-op, and SELECT 1 works through Kysely', async () => {
    const first = await migrate(postgres.url);
    expect(first.applied).toEqual(['0001_baseline.sql']);

    const second = await migrate(postgres.url);
    expect(second.applied).toEqual([]);

    const persistence = createPersistence(postgres.url);
    try {
      const ping = await sql<{ ok: number }>`select 1 as ok`.execute(persistence.db);
      expect(ping.rows[0]?.ok).toBe(1);
      const version = await sql<{
        version: string;
      }>`select current_setting('server_version') as version`.execute(persistence.db);
      expect(version.rows[0]?.version).toMatch(/^18\./);
      const recorded = await sql<{
        filename: string;
      }>`select filename from schema_migrations`.execute(persistence.db);
      expect(recorded.rows).toEqual([{ filename: '0001_baseline.sql' }]);
    } finally {
      await persistence.close();
    }
  });

  it('SK-05 runs concurrent migrate jobs without applying a file twice', async () => {
    const empty = await startPostgres();
    try {
      const results = await Promise.all([migrate(empty.url), migrate(empty.url)]);
      const appliedCount = results.reduce((sum, result) => sum + result.applied.length, 0);
      expect(appliedCount).toBe(1);
    } finally {
      await empty.stop();
    }
  });
});
