import { sql } from 'kysely';
import type { IdempotencyStore } from '#src/capacity/application/ports/index.js';
import type { Outcome } from '#src/capacity/application/shared/problem.js';
import type { Queryable } from './rows.js';

export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Queryable) {}

  /**
   * ON CONFLICT DO NOTHING: a duplicate waits at the unique index for an in-flight winner and
   * then returns no row. There is deliberately no `FOR UPDATE` on this row.
   */
  async claim(tenantId: string, key: string, fingerprint: string) {
    const { rows } = await sql`
      INSERT INTO idempotency_key (tenant_id, key, fingerprint)
      VALUES (${tenantId}, ${key}, ${fingerprint})
      ON CONFLICT (tenant_id, key) DO NOTHING
      RETURNING key`.execute(this.db);
    return rows.length > 0;
  }

  async find(tenantId: string, key: string) {
    const { rows } = await sql<{ fingerprint: string; response_body: Outcome<unknown> | null }>`
      SELECT fingerprint, response_body FROM idempotency_key
       WHERE tenant_id = ${tenantId} AND key = ${key}`.execute(this.db);
    const row = rows[0];
    return row === undefined ? null : { fingerprint: row.fingerprint, outcome: row.response_body };
  }

  async complete(tenantId: string, key: string, statusCode: number, outcome: Outcome<unknown>) {
    await sql`
      UPDATE idempotency_key
         SET status_code = ${statusCode}, response_body = ${JSON.stringify(outcome)}::jsonb
       WHERE tenant_id = ${tenantId} AND key = ${key}`.execute(this.db);
  }
}
