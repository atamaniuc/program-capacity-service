import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KafkaEventPublisher,
  CAPACITY_EVENTS_TOPIC,
} from '#src/capacity/adapters/out/kafka/event-publisher.js';
import { OutboxRelay } from '#src/capacity/adapters/out/kafka/outbox-relay.js';
import { createPersistence, type Persistence } from '#src/capacity/adapters/out/postgres/db.js';
import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { PgOutboxRelayStore } from '#src/capacity/adapters/out/postgres/repositories/outbox-relay.repository.js';
import type { EventPublisher, OutboxRecord } from '#src/capacity/application/ports/index.js';
import { startKafkaBroker, type KafkaBroker } from '../support/outage-containers.js';
import { startPostgres, type TestPostgres } from '../support/postgres.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('outbox relay', () => {
  let postgres: TestPostgres;
  let kafka: KafkaBroker;
  let persistence: Persistence;
  let store: PgOutboxRelayStore;

  beforeAll(async () => {
    [postgres, kafka] = await Promise.all([startPostgres(), startKafkaBroker()]);
    await migrate(postgres.url);
    persistence = createPersistence(postgres.url, 5);
    store = new PgOutboxRelayStore(persistence.db);
  });

  afterAll(async () => {
    await persistence.close();
    await Promise.all([postgres.stop(), kafka.remove()]);
  });

  beforeEach(async () => {
    await sql`TRUNCATE outbox_event`.execute(persistence.db);
    await sql`UPDATE outbox_relay_lease SET owner = NULL, expires_at = 'epoch', epoch = 0`.execute(
      persistence.db,
    );
  });

  async function seedEvents(programs: readonly string[], perProgram: number): Promise<void> {
    // Interleaved insert order: only program_seq decides the delivery order within a program.
    for (let seq = 1; seq <= perProgram; seq += 1) {
      for (const programId of programs) {
        await sql`
          INSERT INTO outbox_event (tenant_id, program_id, program_seq, type, payload)
          VALUES ('bank-a', ${programId}, ${seq}, 'ReservationCreated',
                  ${JSON.stringify({ programId, seq })}::jsonb)`.execute(persistence.db);
      }
    }
  }

  const unpublished = async (): Promise<number> => (await store.lag()).unpublished;

  it('FR-13 publishes the outbox rows of two programs keyed tenantId:programId in program_seq order', async () => {
    await seedEvents(['prg-one', 'prg-two'], 6);
    const relay = new OutboxRelay({
      store,
      publisher: new KafkaEventPublisher({ brokers: [kafka.brokers] }),
      owner: 'relay-a',
      logger: silent,
      batchSize: 5,
    });

    let published = 0;
    while (published < 12) {
      const cycle = await relay.runOnce();
      expect(cycle.state).toBe('published');
      if (cycle.state === 'published') published += cycle.count;
    }
    expect(await unpublished()).toBe(0);

    const messages = await kafka.readTopic(CAPACITY_EVENTS_TOPIC, 12);
    expect(messages).toHaveLength(12);
    for (const programId of ['prg-one', 'prg-two']) {
      const mine = messages.filter((message) => message.key === `bank-a:${programId}`);
      expect(mine.map((message) => message.value['seq'])).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(mine.map((message) => message.partition)).size).toBe(1);
      expect(mine[0]?.value).toMatchObject({
        type: 'ReservationCreated',
        schemaVersion: 1,
        tenantId: 'bank-a',
        programId,
      });
      expect(mine[0]?.headers['event-type']).toBe('ReservationCreated');
      expect(mine[0]?.headers['event-id']).toBe(mine[0]?.value['messageId']);
    }
    await relay.stop();
  });

  it('FR-13 a stale lease holder cannot mark rows published and the new holder resends them', async () => {
    await seedEvents(['prg-one'], 3);
    const real = new KafkaEventPublisher({ brokers: [kafka.brokers] });
    const takeover = new OutboxRelay({
      store,
      publisher: real,
      owner: 'relay-b',
      logger: silent,
    });

    // Relay A sends, but its lease expires and B takes over before A's "mark published" runs.
    const stalling: EventPublisher = {
      publish: async (records: readonly OutboxRecord[]) => {
        await real.publish(records);
        await sql`UPDATE outbox_relay_lease SET expires_at = now() - interval '1 second'`.execute(
          persistence.db,
        );
        const lease = await store.acquireLease('relay-b', 30_000);
        expect(lease?.epoch).toBe(2n);
      },
      close: () => Promise.resolve(),
    };
    const stale = new OutboxRelay({ store, publisher: stalling, owner: 'relay-a', logger: silent });

    expect(await stale.runOnce()).toEqual({ state: 'fenced', sent: 3 });
    expect(stale.heldEpoch()).toBeNull();
    expect(await unpublished()).toBe(3);

    // The holder with the current epoch publishes them (duplicates are dropped by event id).
    expect(await takeover.runOnce()).toEqual({ state: 'published', count: 3 });
    expect(await unpublished()).toBe(0);
    // And the stale holder stays on standby while B's lease is alive.
    expect(await stale.runOnce()).toEqual({ state: 'standby' });
    await takeover.stop();
  });

  it('FR-13 takes over an expired lease with epoch + 1 and only one relay holds it at a time', async () => {
    const first = await store.acquireLease('relay-a', 30_000);
    expect(first).toEqual({ epoch: 1n });
    expect(await store.acquireLease('relay-b', 30_000)).toBeNull();
    expect(await store.renewLease('relay-a', 1n, 30_000)).toBe(true);

    await sql`UPDATE outbox_relay_lease SET expires_at = now() - interval '1 second'`.execute(
      persistence.db,
    );
    expect(await store.renewLease('relay-a', 1n, 30_000)).toBe(false);
    expect(await store.acquireLease('relay-b', 30_000)).toEqual({ epoch: 2n });

    await sql`INSERT INTO outbox_event (tenant_id, program_id, program_seq, type, payload)
              VALUES ('bank-a', 'prg-one', 1, 'ReservationCreated', '{}'::jsonb)`.execute(
      persistence.db,
    );
    const [row] = await store.fetchUnpublished(10);
    expect(await store.markPublished([row?.id ?? ''], 'relay-a', 1n)).toBe(0);
    expect(await store.markPublished([row?.id ?? ''], 'relay-b', 2n)).toBe(1);
  });
});
