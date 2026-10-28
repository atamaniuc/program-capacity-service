import { sql } from 'kysely';
import type { FxRateReader } from '#src/capacity/application/ports/index.js';
import { parseFxRate } from '#src/capacity/domain/index.js';
import type { Queryable } from './rows.js';

export class PgFxRateReader implements FxRateReader {
  constructor(private readonly db: Queryable) {}

  async latest(base: string, quote: string, notBefore: Date) {
    const { rows } = await sql<{ rate: string; source: string; as_of: Date }>`
      SELECT rate, source, as_of FROM fx_rate
       WHERE base = ${base} AND quote = ${quote} AND as_of > ${notBefore}
       ORDER BY as_of DESC
       LIMIT 1`.execute(this.db);
    const row = rows[0];
    if (row === undefined) return null;
    const rate = parseFxRate(row.rate);
    if (!rate.ok) throw new Error(`stored fx_rate ${row.rate} is not a valid rate`);
    return { rate: rate.value, source: row.source, asOf: row.as_of };
  }
}
