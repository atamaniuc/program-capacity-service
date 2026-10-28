import { sql } from 'kysely';
import type { ProgramRepository } from '#src/capacity/application/ports/index.js';
import { toProgram, type ProgramRow, type Queryable } from './rows.js';

export class PgProgramRepository implements ProgramRepository {
  constructor(private readonly db: Queryable) {}

  async lockForUpdate(tenantId: string, programId: string) {
    const { rows } = await sql<ProgramRow>`
      SELECT * FROM program WHERE tenant_id = ${tenantId} AND id = ${programId} FOR UPDATE`.execute(
      this.db,
    );
    return rows[0] === undefined ? null : toProgram(rows[0]);
  }

  /** The WHERE clause backs up the application check (I2): ACTIVE and enough capacity. */
  async reserve(tenantId: string, programId: string, amountMinor: bigint) {
    const amount = amountMinor.toString();
    const { rows } = await sql<ProgramRow>`
      UPDATE program
         SET reserved_minor = reserved_minor + ${amount}::bigint,
             version = version + 1,
             platform_seq = platform_seq + 1,
             updated_at = now()
       WHERE tenant_id = ${tenantId} AND id = ${programId}
         AND status = 'ACTIVE'
         AND credit_limit_minor - reserved_minor >= ${amount}::bigint
      RETURNING *`.execute(this.db);
    return rows[0] === undefined ? null : toProgram(rows[0]);
  }

  async release(tenantId: string, programId: string, amountMinor: bigint) {
    const amount = amountMinor.toString();
    const { rows } = await sql<ProgramRow>`
      UPDATE program
         SET reserved_minor = reserved_minor - ${amount}::bigint,
             version = version + 1,
             platform_seq = platform_seq + 1,
             updated_at = now()
       WHERE tenant_id = ${tenantId} AND id = ${programId}
         AND reserved_minor >= ${amount}::bigint
      RETURNING *`.execute(this.db);
    return rows[0] === undefined ? null : toProgram(rows[0]);
  }
}
