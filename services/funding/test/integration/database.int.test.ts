import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '#src/funding/adapters/out/postgres/migrate.js';
import { startFundingPostgres, type FundingPostgres } from '../support/postgres.js';

let server: FundingPostgres;

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  server = await startFundingPostgres();
  await migrate(server.fundingUrl);
});

afterAll(async () => {
  await server.stop();
});

describe('funding database (ADR 023)', () => {
  it('FS-14 the capacity role is refused on the funding database', async () => {
    await expect(connect(server.url('capacity', 'capacity', 'funding'))).rejects.toThrow(
      /permission denied|not have CONNECT/i,
    );
  });

  it('FS-14 the funding role is refused on the capacity database', async () => {
    await expect(connect(server.url('funding', 'funding', 'capacity'))).rejects.toThrow(
      /permission denied|not have CONNECT/i,
    );
  });

  it('FS-14 neither role is a superuser and the funding tables are not visible from capacity', async () => {
    const capacity = await connect(server.capacityUrl);
    try {
      const role = await capacity.query<{ rolsuper: boolean }>(
        "SELECT rolsuper FROM pg_roles WHERE rolname IN ('capacity', 'funding')",
      );
      expect(role.rows.map((row) => row.rolsuper)).toEqual([false, false]);
      await expect(capacity.query('SELECT 1 FROM funding_request')).rejects.toThrow(
        /does not exist/,
      );
    } finally {
      await capacity.end();
    }
  });

  it('FS-14 the migrations create the funding tables and record themselves', async () => {
    const funding = await connect(server.fundingUrl);
    try {
      const tables = await funding.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'funding_request',
        'idempotency_key',
        'outbox_event',
        'saga_step_attempt',
        'schema_migrations',
      ]);
      expect((await migrate(server.fundingUrl)).applied).toEqual([]);
    } finally {
      await funding.end();
    }
  });

  it('FS-14 a funding request is unique per tenant, program and invoice', async () => {
    const funding = await connect(server.fundingUrl);
    try {
      const insert = (): Promise<unknown> =>
        funding.query(
          `INSERT INTO funding_request (tenant_id, program_id, invoice_id, currency, amount_minor, state)
           VALUES ('t1', 'p1', 'inv-unique', 'USD', 100, 'RECEIVED')`,
        );
      await insert();
      await expect(insert()).rejects.toThrow(/duplicate key/);
      await expect(
        funding.query(
          `INSERT INTO funding_request (tenant_id, program_id, invoice_id, currency, amount_minor, state)
           VALUES ('t1', 'p1', 'inv-bad', 'USD', 0, 'RECEIVED')`,
        ),
      ).rejects.toThrow(/check constraint/);
    } finally {
      await funding.end();
    }
  });

  it('FS-14 saga_step_attempt is append-only', async () => {
    const funding = await connect(server.fundingUrl);
    try {
      const request = await funding.query<{ id: string }>(
        `INSERT INTO funding_request (tenant_id, program_id, invoice_id, currency, amount_minor, state)
         VALUES ('t1', 'p1', 'inv-audit', 'USD', 100, 'RECEIVED') RETURNING id`,
      );
      const id = request.rows[0]?.id;
      await funding.query(
        `INSERT INTO saga_step_attempt (request_id, step, step_key, outcome_class, state_before, state_after)
         VALUES ($1, 'risk', NULL, 'success', 'RECEIVED', 'RESERVING')`,
        [id],
      );
      await expect(funding.query("UPDATE saga_step_attempt SET step = 'reserve'")).rejects.toThrow(
        /append-only/,
      );
      await expect(funding.query('DELETE FROM saga_step_attempt')).rejects.toThrow(/append-only/);
      await expect(funding.query('TRUNCATE saga_step_attempt')).rejects.toThrow(/append-only/);
    } finally {
      await funding.end();
    }
  });

  it('FS-14 the database refuses a step state without its business deadline', async () => {
    const funding = await connect(server.fundingUrl);
    try {
      const insert = (
        invoice: string,
        state: string,
        reservation: string | null,
        extra = '',
      ): Promise<unknown> =>
        funding.query(
          `INSERT INTO funding_request (tenant_id, program_id, invoice_id, currency, amount_minor, state, reservation_id ${extra === '' ? '' : ', ' + extra.split('=')[0]})
           VALUES ('t1', 'p1', $1, 'USD', 100, $2, $3 ${extra === '' ? '' : ', now()'})`,
          [invoice, state, reservation],
        );
      await expect(insert('dl-1', 'RESERVING', null)).rejects.toThrow(
        /funding_request_reserve_deadline/,
      );
      await expect(insert('dl-2', 'DISBURSING', 'res-1')).rejects.toThrow(
        /funding_request_disburse_deadline/,
      );
      await expect(insert('dl-3', 'COMPENSATING', null)).rejects.toThrow(
        /funding_request_resolution_deadline/,
      );
      await insert('dl-4', 'RESERVING', null, 'reserve_deadline_at=');
      await insert('dl-5', 'DISBURSING', 'res-1', 'disburse_deadline_at=');
      await insert('dl-6', 'COMPENSATING', null, 'resolution_deadline_at=');
      await insert('dl-7', 'COMPENSATING', 'res-1');
    } finally {
      await funding.end();
    }
  });
});
