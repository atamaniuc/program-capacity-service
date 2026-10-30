import { Kysely, PostgresDialect, type Generated } from 'kysely';
import pg from 'pg';

/** Table types for the queries the service makes; bigint columns travel as strings. */
export interface FundingRequestTable {
  id: Generated<string>;
  tenant_id: string;
  program_id: string;
  invoice_id: string;
  currency: string;
  amount_minor: string;
  state: string;
  reason: Generated<string | null>;
  reservation_id: Generated<string | null>;
  payment_id: Generated<string | null>;
  created_at: Generated<Date>;
}

export interface Database {
  funding_request: FundingRequestTable;
  idempotency_key: {
    tenant_id: string;
    key: string;
    fingerprint: string;
    status_code: number | null;
    response_body: unknown;
  };
  outbox_event: {
    tenant_id: string;
    request_id: string;
    type: string;
    payload: unknown;
  };
}

export interface Persistence {
  readonly db: Kysely<Database>;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createPersistence(databaseUrl: string, maxConnections = 10): Persistence {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: maxConnections });
  // A database restart terminates idle pooled clients; the next query opens a fresh connection.
  pool.on('error', () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool, close: () => db.destroy() };
}
