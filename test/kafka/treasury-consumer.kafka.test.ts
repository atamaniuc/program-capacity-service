import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOPIC_CAPACITY } from '#src/capacity/application/shared/treasury-messages.js';
import { contractValidators } from '../../tools/contracts/validators.js';
import { limitSet, repayment, snapshot } from '../../tools/simulator/messages.js';
import { count, programRow, seedFxRate } from '../support/capacity-world.js';
import { startTreasuryWorld, waitFor, type TreasuryWorld } from './support/world.js';

const TENANT = 'bank-a';
const usd = (value: string) => ({ value, currency: 'USD' });

describe('treasury consumer', () => {
  let world: TreasuryWorld;
  let invoiceCounter = 0;

  const at = (programId: string, seq: number) => ({ tenantId: TENANT, programId, seq });

  async function reserve(programId: string, minor: bigint, currency = 'USD'): Promise<string> {
    const outcome = await world.capacity.reserve.execute({
      tenantId: TENANT,
      actor: 'svc-orders',
      requestId: 'req',
      programId,
      invoiceId: `INV-${++invoiceCounter}`,
      invoiceAmount: { minor, currency },
    });
    if (!outcome.ok) throw new Error(`setup reserve failed: ${outcome.problem.type}`);
    return outcome.value.reservationId;
  }

  async function waitForOffset(topic: string, offset: number): Promise<void> {
    await waitFor(
      async () => ((await world.committedOffset(topic)) >= offset ? true : undefined),
      `offset ${offset} committed on ${topic}`,
    );
  }

  beforeAll(async () => {
    world = await startTreasuryWorld();
    await seedFxRate(world.capacity, { base: 'EUR', quote: 'USD', rate: '1.1' });
  });

  afterAll(async () => {
    await world.close();
  });

  it('AC-10 a redelivered message has no effect and its offset is committed', async () => {
    const message = limitSet(at('prg-dup', 1), usd('5000000.00'));
    await world.send([message]);
    await waitForOffset(TOPIC_CAPACITY, 1);
    const ledgerAfterFirst = await count(world.capacity, 'ledger_entry', "program_id = 'prg-dup'");
    const outboxAfterFirst = await count(world.capacity, 'outbox_event', "program_id = 'prg-dup'");
    expect(ledgerAfterFirst).toBe(1);

    const before = await programRow(world.capacity, TENANT, 'prg-dup');
    await world.send([message]);
    await waitForOffset(TOPIC_CAPACITY, 2);
    // The broker agrees: the group will read from offset 2, so the duplicate was committed too.
    expect(await world.brokerCommittedOffset(TOPIC_CAPACITY)).toBe(2);

    expect(await count(world.capacity, 'ledger_entry', "program_id = 'prg-dup'")).toBe(
      ledgerAfterFirst,
    );
    expect(await count(world.capacity, 'outbox_event', "program_id = 'prg-dup'")).toBe(
      outboxAfterFirst,
    );
    expect(await programRow(world.capacity, TENANT, 'prg-dup')).toEqual(before);
    expect(
      await count(
        world.capacity,
        'inbox_message',
        "consumer = 'treasury-capacity' AND message_id LIKE '%prg-dup%'",
      ),
    ).toBe(1);
    expect(world.logs.some((log) => log.fields['event'] === 'duplicate-skipped')).toBe(true);
  });

  it('AC-11 a message that fails schema validation lands in the DLQ and the partition keeps moving', async () => {
    const before = await world.committedOffset(TOPIC_CAPACITY);
    const good = limitSet(at('prg-poison', 1), usd('1000000.00'));
    await world.sendRaw(TOPIC_CAPACITY, `${TENANT}:prg-poison`, '{"this is": not json');
    await world.sendRaw(
      TOPIC_CAPACITY,
      `${TENANT}:prg-poison`,
      JSON.stringify({ messageId: 'bad', type: 'ProgramLimitSet', payload: {} }),
    );
    await world.send([good]);
    await waitForOffset(TOPIC_CAPACITY, before + 3);

    const parked = await world.readTopic(`${TOPIC_CAPACITY}.dlq`, 2);
    expect(parked).toHaveLength(2);
    expect(parked[0]?.value?.toString()).toBe('{"this is": not json');
    expect(parked[1]?.value?.toString()).toBe(
      JSON.stringify({ messageId: 'bad', type: 'ProgramLimitSet', payload: {} }),
    );
    const validators = await contractValidators();
    for (const record of parked) {
      expect(record?.key?.toString()).toBe(`${TENANT}:prg-poison`);
      const headers = record?.headers as Record<string, Buffer>;
      // The DlqHeaders schema published in contracts/asyncapi.yaml.
      const asText = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, value.toString()]),
      );
      expect(validators.dlqHeaders(asText), validators.errors(validators.dlqHeaders)).toBe(true);
      expect(headers['x-error-code']?.toString()).toBe('schema-invalid');
      expect(headers['x-error-message']?.toString().length).toBeGreaterThan(0);
      expect(headers['x-original-topic']?.toString()).toBe(TOPIC_CAPACITY);
      expect(headers['x-original-partition']?.toString()).toBe('0');
      expect(Number(headers['x-original-offset']?.toString())).toBeGreaterThanOrEqual(before);
    }

    const row = await programRow(world.capacity, TENANT, 'prg-poison');
    expect(row.credit_limit_minor).toBe('100000000');
  });

  it('AC-07 a limit cut below reserved leaves available 0 and overLimitBy 620,000; releases still succeed', async () => {
    await world.send([limitSet(at('prg-cut', 1), usd('10000000.00'))]);
    await waitFor(
      async () =>
        (await programRow(world.capacity, TENANT, 'prg-cut').catch(() => null))
          ?.credit_limit_minor === '1000000000'
          ? true
          : undefined,
      'program created',
    );
    const first = await reserve('prg-cut', 200_000_000n);
    await reserve('prg-cut', 162_000_000n);

    await world.send([limitSet(at('prg-cut', 2), usd('3000000.00'))]);
    await waitFor(
      async () =>
        (await programRow(world.capacity, TENANT, 'prg-cut')).credit_limit_minor === '300000000'
          ? true
          : undefined,
      'limit cut applied',
    );

    const view = await world.capacity.getCapacity.execute({
      tenantId: TENANT,
      programId: 'prg-cut',
    });
    if (!view.ok) throw new Error('capacity not found');
    expect(view.value.reserved).toBe('3620000.00');
    expect(view.value.available).toBe('0.00');
    expect(view.value.overLimitBy).toBe('620000.00');

    const refused = await world.capacity.reserve.execute({
      tenantId: TENANT,
      actor: 'svc-orders',
      requestId: 'req',
      programId: 'prg-cut',
      invoiceId: 'INV-NEW',
      invoiceAmount: { minor: 100n, currency: 'USD' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.problem.type).toBe('program-over-limit');

    const released = await world.capacity.release.execute({
      tenantId: TENANT,
      actor: 'svc-orders',
      requestId: 'req',
      programId: 'prg-cut',
      reservationId: first,
      releaseRef: 'rel-cut',
      reason: 'CANCELLED',
    });
    expect(released.ok).toBe(true);
    expect(
      await count(world.capacity, 'ledger_entry', "program_id = 'prg-cut' AND kind = 'LIMIT_SET'"),
    ).toBe(2);
  });

  it('AC-09 an event or snapshot with seq at or below the program seq is skipped, logged and committed', async () => {
    await world.send([limitSet(at('prg-seq', 42), usd('5000000.00'))]);
    await waitFor(
      async () =>
        (await programRow(world.capacity, TENANT, 'prg-seq').catch(() => null)) ? true : undefined,
      'program created',
    );
    const ledgerBefore = await count(world.capacity, 'ledger_entry', "program_id = 'prg-seq'");
    const before = await programRow(world.capacity, TENANT, 'prg-seq');
    const offset = await world.committedOffset(TOPIC_CAPACITY);

    await world.send([
      limitSet(at('prg-seq', 41), usd('1.00')),
      limitSet({ ...at('prg-seq', 42), messageId: 'second-42' }, usd('2.00'), 'SUSPENDED'),
      repayment(at('prg-seq', 40), { invoiceId: 'INV-X', releaseRef: 'r', amount: usd('1.00') }),
      snapshot(at('prg-seq', 39), {
        asOf: new Date(),
        creditLimit: usd('1.00'),
        platformWatermark: 0,
        reservations: [],
      }),
    ]);
    await waitForOffset(TOPIC_CAPACITY, offset + 4);

    expect(await programRow(world.capacity, TENANT, 'prg-seq')).toEqual(before);
    expect(await count(world.capacity, 'ledger_entry', "program_id = 'prg-seq'")).toBe(
      ledgerBefore,
    );
    const skipped = world.logs.filter(
      (log) => log.fields['event'] === 'stale-skipped' && log.fields['programId'] === 'prg-seq',
    );
    expect(skipped).toHaveLength(4);
    const row = await sql<{ treasury_seq: string }>`
      SELECT treasury_seq FROM program WHERE id = 'prg-seq'`.execute(world.capacity.persistence.db);
    expect(row.rows[0]?.treasury_seq).toBe('42');
  });
});
