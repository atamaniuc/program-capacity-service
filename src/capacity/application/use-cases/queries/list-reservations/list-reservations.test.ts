import { describe, expect, it } from 'vitest';
import type { QueryReader } from '../../../ports/index.js';
import { decodeCursor, encodeCursor } from '../../../shared/cursor.js';
import { parseFxRate, type Program, type Reservation } from '#src/capacity/domain/index.js';
import { ListReservations } from './list-reservations.js';

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

function reservation(n: number): Reservation {
  const rate = parseFxRate('1');
  if (!rate.ok) throw new Error('setup');
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    tenantId: 'bank-a',
    programId: 'p1',
    invoiceId: `INV-${n}`,
    invoiceAmount: { minor: 100n, currency: 'USD' },
    fx: { rate: rate.value, source: 'identity', at: new Date(0) },
    amountMinor: 100n,
    releasedMinor: 0n,
    releasedInvoiceMinor: 0n,
    status: 'ACTIVE',
    origin: 'API',
    platformSeq: n,
    createdAt: new Date(0),
  };
}

function readerOf(count: number): QueryReader {
  const all = Array.from({ length: count }, (_, index) => reservation(index + 1));
  return {
    getProgram: (tenantId, programId) =>
      Promise.resolve(tenantId === 'bank-a' && programId === 'p1' ? program : null),
    listReservations: (query) =>
      Promise.resolve(
        all
          .filter((r) => query.afterId === undefined || r.id > query.afterId)
          .slice(0, query.limit),
      ),
    listLedger: () => Promise.resolve([]),
  };
}

describe('list reservations', () => {
  it('FR-12 pages with an opaque cursor and ends with a null cursor', async () => {
    const list = new ListReservations(readerOf(5));
    const first = await list.execute({ tenantId: 'bank-a', programId: 'p1', limit: 2 });
    if (!first.ok) throw new Error('expected a page');
    expect(first.value.items.map((item) => item.invoiceId)).toEqual(['INV-1', 'INV-2']);
    const cursor = first.value.nextCursor;
    expect(cursor).not.toBeNull();

    const second = await list.execute({
      tenantId: 'bank-a',
      programId: 'p1',
      limit: 2,
      cursor: cursor ?? '',
    });
    if (!second.ok) throw new Error('expected a page');
    expect(second.value.items.map((item) => item.invoiceId)).toEqual(['INV-3', 'INV-4']);

    const last = await list.execute({
      tenantId: 'bank-a',
      programId: 'p1',
      limit: 2,
      cursor: second.value.nextCursor ?? '',
    });
    if (!last.ok) throw new Error('expected a page');
    expect(last.value).toMatchObject({ nextCursor: null });
    expect(last.value.items).toHaveLength(1);
  });

  it('FR-12 rejects a forged cursor and answers 404 for an unknown program', async () => {
    const list = new ListReservations(readerOf(1));
    const forged = await list.execute({
      tenantId: 'bank-a',
      programId: 'p1',
      limit: 2,
      cursor: encodeCursor('not-a-uuid'),
    });
    expect(forged).toMatchObject({ ok: false, problem: { type: 'validation-error' } });
    const unknown = await list.execute({ tenantId: 'bank-b', programId: 'p1', limit: 2 });
    expect(unknown).toMatchObject({ ok: false, problem: { type: 'not-found' } });
    expect(decodeCursor('%%%')).toBeNull();
    expect(decodeCursor(Buffer.from('"x"').toString('base64url'))).toBeNull();
  });
});
