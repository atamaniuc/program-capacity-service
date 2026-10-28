import { describe, expect, it } from 'vitest';
import type { LedgerRecord, QueryReader } from '../../../ports/index.js';
import { encodeCursor } from '../../../shared/cursor.js';
import type { Program } from '#src/capacity/domain/index.js';
import { GetLedger } from './get-ledger.js';

const program: Program = {
  tenantId: 'bank-a',
  id: 'p1',
  currency: 'USD',
  creditLimitMinor: 1_000_000n,
  reservedMinor: 0n,
  status: 'ACTIVE',
  version: 0,
  treasurySeq: 0,
  platformSeq: 0,
};

const entries: LedgerRecord[] = [1n, 2n, 3n].map((id) => ({
  id,
  reservationId: null,
  kind: 'LIMIT_SET',
  deltaReservedMinor: 0n,
  deltaLimitMinor: 1_000_000n,
  limitAfter: 1_000_000n,
  reservedAfter: 0n,
  causeType: 'treasury',
  causeId: `m-${id}`,
  actor: 'treasury',
  createdAt: new Date(0),
}));

const reader: QueryReader = {
  getProgram: (tenantId) => Promise.resolve(tenantId === 'bank-a' ? program : null),
  listReservations: () => Promise.resolve([]),
  listLedger: (query) =>
    Promise.resolve(
      entries
        .filter((entry) => query.afterId === undefined || entry.id > query.afterId)
        .slice(0, query.limit),
    ),
};

describe('get ledger', () => {
  it('FR-12 pages the ledger oldest first with money views and an opaque cursor', async () => {
    const ledger = new GetLedger(reader);
    const first = await ledger.execute({ tenantId: 'bank-a', programId: 'p1', limit: 2 });
    if (!first.ok) throw new Error('expected a page');
    expect(first.value.items.map((entry) => entry.entryId)).toEqual(['1', '2']);
    expect(first.value.items[0]).toMatchObject({
      deltaLimit: { value: '10000.00', currency: 'USD' },
      actor: 'treasury',
    });

    const second = await ledger.execute({
      tenantId: 'bank-a',
      programId: 'p1',
      limit: 2,
      cursor: first.value.nextCursor ?? '',
    });
    if (!second.ok) throw new Error('expected a page');
    expect(second.value.items.map((entry) => entry.entryId)).toEqual(['3']);
    expect(second.value.nextCursor).toBeNull();
  });

  it('FR-12 rejects a forged cursor and answers 404 for another tenant', async () => {
    const ledger = new GetLedger(reader);
    expect(
      await ledger.execute({
        tenantId: 'bank-a',
        programId: 'p1',
        limit: 2,
        cursor: encodeCursor('abc'),
      }),
    ).toMatchObject({ ok: false, problem: { type: 'validation-error' } });
    expect(await ledger.execute({ tenantId: 'bank-b', programId: 'p1', limit: 2 })).toMatchObject({
      ok: false,
      problem: { type: 'not-found' },
    });
  });
});
