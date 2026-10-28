import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

/** Table types are added by the lane that creates each table. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database {}

export interface Persistence {
  readonly db: Kysely<Database>;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createPersistence(databaseUrl: string, maxConnections = 10): Persistence {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: maxConnections });
  // A database restart terminates idle pooled clients; without a listener that 'error' event
  // would crash the process. The next query opens a fresh connection (NFR-06).
  pool.on('error', () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    // Kysely.destroy() ends the pool it was given; nothing else to close.
    close: () => db.destroy(),
  };
}
