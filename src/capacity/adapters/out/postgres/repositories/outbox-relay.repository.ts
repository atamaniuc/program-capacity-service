import { sql } from 'kysely';
import type {
  OutboxLag,
  OutboxRecord,
  OutboxRelayStore,
  RelayLease,
} from '#src/capacity/application/ports/index.js';
import type { Queryable } from './rows.js';

const LEASE_ID = 'outbox-relay';

interface OutboxRow {
  id: string;
  tenant_id: string;
  program_id: string;
  program_seq: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

/**
 * Relay lease and outbox reads on the primary. Every statement is one round trip and uses the
 * database clock, so no worker clock decides who holds the lease.
 */
export class PgOutboxRelayStore implements OutboxRelayStore {
  constructor(private readonly db: Queryable) {}

  async acquireLease(owner: string, ttlMs: number): Promise<RelayLease | null> {
    // The row lock serialises competing takers; under READ COMMITTED the losers re-evaluate the
    // WHERE clause against the winner's row and fall through with no row.
    const { rows } = await sql<{ epoch: string }>`
      UPDATE outbox_relay_lease
         SET epoch = CASE WHEN owner = ${owner} AND expires_at > now() THEN epoch ELSE epoch + 1 END,
             owner = ${owner},
             expires_at = now() + make_interval(secs => ${ttlMs / 1000})
       WHERE id = ${LEASE_ID} AND (owner IS NULL OR owner = ${owner} OR expires_at <= now())
      RETURNING epoch`.execute(this.db);
    return rows[0] === undefined ? null : { epoch: BigInt(rows[0].epoch) };
  }

  async renewLease(owner: string, epoch: bigint, ttlMs: number): Promise<boolean> {
    const { rows } = await sql`
      UPDATE outbox_relay_lease
         SET expires_at = now() + make_interval(secs => ${ttlMs / 1000})
       WHERE id = ${LEASE_ID} AND owner = ${owner} AND epoch = ${epoch.toString()}::bigint
         AND expires_at > now()
      RETURNING epoch`.execute(this.db);
    return rows.length === 1;
  }

  async releaseLease(owner: string, epoch: bigint): Promise<void> {
    await sql`
      UPDATE outbox_relay_lease SET owner = NULL, expires_at = 'epoch'
       WHERE id = ${LEASE_ID} AND owner = ${owner} AND epoch = ${epoch.toString()}::bigint`.execute(
      this.db,
    );
  }

  async fetchUnpublished(limit: number): Promise<readonly OutboxRecord[]> {
    const { rows } = await sql<OutboxRow>`
      SELECT id, tenant_id, program_id, program_seq, type, payload, created_at
        FROM outbox_event
       WHERE published_at IS NULL
       ORDER BY tenant_id, program_id, program_seq, id
       LIMIT ${limit}`.execute(this.db);
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      programId: row.program_id,
      programSeq: BigInt(row.program_seq),
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }

  async markPublished(ids: readonly string[], owner: string, epoch: bigint): Promise<number> {
    if (ids.length === 0) return 0;
    // The lease check and the update are one statement: a stale holder marks nothing.
    const result = await sql`
      UPDATE outbox_event SET published_at = now()
       WHERE id = ANY(${ids}::uuid[]) AND published_at IS NULL
         AND EXISTS (SELECT 1 FROM outbox_relay_lease
                      WHERE id = ${LEASE_ID} AND owner = ${owner}
                        AND epoch = ${epoch.toString()}::bigint AND expires_at > now())`.execute(
      this.db,
    );
    return Number(result.numAffectedRows ?? 0n);
  }

  async lag(): Promise<OutboxLag> {
    const { rows } = await sql<{ unpublished: string; oldest: string | null }>`
      SELECT count(*) AS unpublished,
             EXTRACT(EPOCH FROM now() - min(created_at))::text AS oldest
        FROM outbox_event WHERE published_at IS NULL`.execute(this.db);
    const row = rows[0];
    return {
      unpublished: Number(row?.unpublished ?? 0),
      oldestAgeSeconds: row?.oldest == null ? 0 : Number(row.oldest),
    };
  }
}
