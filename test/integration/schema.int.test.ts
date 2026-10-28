import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedProgram, startCapacityWorld, type CapacityWorld } from '../support/capacity-world.js';

describe('core schema', () => {
  let world: CapacityWorld;

  async function expectRejected(statement: ReturnType<typeof sql>, pattern: RegExp): Promise<void> {
    await expect(statement.execute(world.persistence.db)).rejects.toThrow(pattern);
  }

  beforeAll(async () => {
    world = await startCapacityWorld();
    await seedProgram(world, { tenantId: 'bank-a', id: 'p1', limitMinor: 1_000n });
    await sql`
      INSERT INTO reservation (id, tenant_id, program_id, invoice_id, invoice_amount_minor,
        invoice_currency, fx_rate, fx_rate_source, fx_rate_at, amount_minor, platform_seq)
      VALUES (uuidv7(), 'bank-a', 'p1', 'INV-1', 100, 'USD', 1, 'identity', now(), 100, 1)`.execute(
      world.persistence.db,
    );
    await sql`
      INSERT INTO ledger_entry (tenant_id, program_id, kind, delta_reserved_minor, limit_after,
        reserved_after, cause_type, cause_id, actor)
      VALUES ('bank-a', 'p1', 'RESERVE', 100, 1000, 100, 'http', 'req-1', 'svc')`.execute(
      world.persistence.db,
    );
  });

  afterAll(async () => {
    await world.close();
  });

  it('NFR-09 refuses UPDATE, DELETE and TRUNCATE on ledger_entry in the database', async () => {
    await expectRejected(sql`UPDATE ledger_entry SET actor = 'mallory'`, /append-only/);
    await expectRejected(sql`DELETE FROM ledger_entry`, /append-only/);
    await expectRejected(sql`TRUNCATE ledger_entry`, /append-only/);
    const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ledger_entry`.execute(
      world.persistence.db,
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('NFR-09 creates the eight PRD tables and the outbox relay lease with a seeded row', async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(
      world.persistence.db,
    );
    const names = rows.map((row) => row.table_name);
    for (const table of [
      'program',
      'reservation',
      'reservation_release',
      'ledger_entry',
      'fx_rate',
      'idempotency_key',
      'inbox_message',
      'outbox_event',
      'outbox_relay_lease',
    ]) {
      expect(names).toContain(table);
    }
    const lease = await sql`SELECT * FROM outbox_relay_lease`.execute(world.persistence.db);
    expect(lease.rows).toHaveLength(1);
  });

  it('NFR-09 keys programs by (tenant, id) so two tenants can share an id', async () => {
    await seedProgram(world, { tenantId: 'bank-b', id: 'p1', limitMinor: 5n });
    await expectRejected(
      sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor) VALUES ('bank-a', 'p1', 'USD', 1)`,
      /duplicate key/,
    );
  });

  it('NFR-09 enforces the money CHECK constraints', async () => {
    await expectRejected(
      sql`UPDATE program SET reserved_minor = -1 WHERE tenant_id = 'bank-a'`,
      /reserved_minor/,
    );
    await expectRejected(
      sql`UPDATE program SET credit_limit_minor = -1 WHERE tenant_id = 'bank-a'`,
      /credit_limit_minor/,
    );
    await expectRejected(
      sql`UPDATE reservation SET released_minor = 101`,
      /violates check constraint/,
    );
    await expectRejected(
      sql`UPDATE reservation SET released_minor = -1`,
      /violates check constraint/,
    );
    await expectRejected(
      sql`UPDATE reservation SET status = 'RELEASED'`,
      /violates check constraint/,
    );
    await expectRejected(sql`UPDATE reservation SET status = 'LOST'`, /status/);
  });

  it('NFR-09 enforces one reservation per invoice and one release per release_ref', async () => {
    await expectRejected(
      sql`INSERT INTO reservation (tenant_id, program_id, invoice_id, invoice_amount_minor,
            invoice_currency, fx_rate, fx_rate_source, fx_rate_at, amount_minor, platform_seq)
          VALUES ('bank-a', 'p1', 'INV-1', 1, 'USD', 1, 'identity', now(), 1, 1)`,
      /duplicate key/,
    );
    await sql`INSERT INTO reservation_release (reservation_id, release_ref, fingerprint, reason)
              SELECT id, 'r1', 'f', 'REPAID' FROM reservation`.execute(world.persistence.db);
    await expectRejected(
      sql`INSERT INTO reservation_release (reservation_id, release_ref, fingerprint, reason)
          SELECT id, 'r1', 'g', 'CANCELLED' FROM reservation`,
      /duplicate key/,
    );
    await expectRejected(
      sql`INSERT INTO reservation_release (reservation_id, release_ref, fingerprint, reason)
          SELECT id, 'r2', 'g', 'GIFT' FROM reservation`,
      /reason/,
    );
  });

  it('NFR-09 stores rates as NUMERIC(20,10) and returns them as exact strings', async () => {
    await sql`INSERT INTO fx_rate (base, quote, rate, source, as_of)
              VALUES ('EUR', 'USD', 1.1234567891, 'treasury', now())`.execute(world.persistence.db);
    const { rows } = await sql<{ rate: string }>`SELECT rate FROM fx_rate`.execute(
      world.persistence.db,
    );
    expect(rows[0]?.rate).toBe('1.1234567891');
  });
});
