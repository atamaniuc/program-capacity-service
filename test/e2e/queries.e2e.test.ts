/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- response bodies are parsed JSON */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

describe('query endpoints', () => {
  let app: TestApp;
  const base = '/v1/programs/prg-list';

  beforeAll(async () => {
    app = await startTestApp();
    const db = app.persistence.db;
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor, reserved_minor)
              VALUES ('bank-a', 'prg-list', 'USD', 1000000000, 120000),
                     ('bank-b', 'prg-list', 'USD', 1000000000, 0)`.execute(db);
    // 120 ACTIVE and 5 RELEASED reservations for bank-a, one ACTIVE for bank-b with the same program id.
    await sql`
      INSERT INTO reservation (tenant_id, program_id, invoice_id, invoice_amount_minor, invoice_currency,
                               fx_rate, fx_rate_source, fx_rate_at, amount_minor, platform_seq)
      SELECT 'bank-a', 'prg-list', 'INV-' || lpad(g::text, 4, '0'), 1000, 'USD', 1, 'identity', now(), 1000, g
        FROM generate_series(1, 120) g`.execute(db);
    await sql`
      INSERT INTO reservation (tenant_id, program_id, invoice_id, invoice_amount_minor, invoice_currency,
                               fx_rate, fx_rate_source, fx_rate_at, amount_minor, released_minor,
                               released_invoice_minor, status, platform_seq)
      SELECT 'bank-a', 'prg-list', 'DONE-' || g, 1000, 'USD', 1, 'identity', now(), 1000, 1000, 1000,
             'RELEASED', 200 + g
        FROM generate_series(1, 5) g`.execute(db);
    await sql`
      INSERT INTO reservation (tenant_id, program_id, invoice_id, invoice_amount_minor, invoice_currency,
                               fx_rate, fx_rate_source, fx_rate_at, amount_minor, platform_seq)
      VALUES ('bank-b', 'prg-list', 'OTHER-TENANT', 1000, 'USD', 1, 'identity', now(), 1000, 1)`.execute(
      db,
    );
    await sql`
      INSERT INTO ledger_entry (tenant_id, program_id, kind, delta_reserved_minor, limit_after,
                                reserved_after, cause_type, cause_id, actor)
      SELECT 'bank-a', 'prg-list', 'RESERVE', 1000, 1000000000, g * 1000, 'api', 'req-' || g, 'svc-orders'
        FROM generate_series(1, 120) g`.execute(db);
    await sql`
      INSERT INTO ledger_entry (tenant_id, program_id, kind, delta_reserved_minor, limit_after,
                                reserved_after, cause_type, cause_id, actor)
      VALUES ('bank-b', 'prg-list', 'RESERVE', 1000, 1000000000, 1000, 'api', 'req-b', 'svc-b')`.execute(
      db,
    );
  });

  afterAll(async () => {
    await app.stop();
  });

  async function readAll(path: string): Promise<{ pages: any[][]; calls: number }> {
    const pages: any[][] = [];
    let cursor: string | null = null;
    do {
      const url: string =
        cursor === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${cursor}`;
      const response = await app.request('GET', url);
      expect(response.status).toBe(200);
      pages.push(response.body.items);
      cursor = response.body.nextCursor;
    } while (cursor !== null);
    return { pages, calls: pages.length };
  }

  it('FR-12 lists 120 ACTIVE reservations in three stable pages of 50, 50 and 20, tenant-filtered', async () => {
    const { pages } = await readAll(`${base}/reservations?status=ACTIVE&limit=50`);
    expect(pages.map((page) => page.length)).toEqual([50, 50, 20]);

    const ids = pages.flat().map((item) => item.reservationId as string);
    expect(new Set(ids).size).toBe(120);
    expect([...ids].sort()).toEqual(ids);
    expect(pages.flat().every((item) => item.status === 'ACTIVE')).toBe(true);
    expect(pages.flat().some((item) => item.invoiceId === 'OTHER-TENANT')).toBe(false);

    // Same cursor, same page: the position does not depend on server state.
    const first = await app.request('GET', `${base}/reservations?status=ACTIVE&limit=50`);
    const second = await app.request(
      'GET',
      `${base}/reservations?status=ACTIVE&limit=50&cursor=${first.body.nextCursor}`,
    );
    const again = await app.request(
      'GET',
      `${base}/reservations?status=ACTIVE&limit=50&cursor=${first.body.nextCursor}`,
    );
    expect(second.body).toEqual(again.body);
    expect(first.body.items[0]).toMatchObject({
      reservedAmount: { value: '10.00', currency: 'USD' },
      fx: { source: 'identity' },
    });
  });

  it('FR-12 filters by invoiceId and status and defaults to a page of 50', async () => {
    const byInvoice = await app.request('GET', `${base}/reservations?invoiceId=INV-0007`);
    expect(byInvoice.body.items.map((item: any) => item.invoiceId)).toEqual(['INV-0007']);
    expect(byInvoice.body.nextCursor).toBeNull();

    const released = await app.request('GET', `${base}/reservations?status=RELEASED`);
    expect(released.body.items).toHaveLength(5);

    const all = await app.request('GET', `${base}/reservations`);
    expect(all.body.items).toHaveLength(50);
    expect(all.body.nextCursor).toEqual(expect.any(String));
  });

  it('FR-12 pages the ledger the same way, oldest first and tenant-filtered', async () => {
    const { pages } = await readAll(`${base}/ledger?limit=50`);
    expect(pages.map((page) => page.length)).toEqual([50, 50, 20]);
    const entries = pages.flat();
    expect(entries.map((entry) => Number(entry.entryId))).toEqual(
      [...entries.map((entry) => Number(entry.entryId))].sort((a, b) => a - b),
    );
    expect(entries.every((entry) => entry.actor === 'svc-orders')).toBe(true);
    expect(entries[0]).toMatchObject({
      kind: 'RESERVE',
      deltaReserved: { value: '10.00', currency: 'USD' },
      reservedAfter: { value: '10.00', currency: 'USD' },
      causeType: 'api',
    });
  });

  it('FR-12 shows the entry a real reservation leaves in the ledger', async () => {
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
              VALUES ('bank-a', 'prg-live', 'USD', 1000000000)`.execute(app.persistence.db);
    const created = await app.request('POST', '/v1/programs/prg-live/reservations', {
      body: { invoiceId: 'INV-LIVE', amount: { value: '125.50', currency: 'USD' } },
    });
    expect(created.status).toBe(201);
    const ledger = await app.request('GET', '/v1/programs/prg-live/ledger');
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({
      kind: 'RESERVE',
      reservationId: created.body.reservationId,
      deltaReserved: { value: '125.50', currency: 'USD' },
      actor: 'svc-orders',
    });
  });

  it('FR-12 answers 404 for another tenant, 400 for a bad cursor or page size, 403 and 401 for auth', async () => {
    const otherTenant = await app.token({ tenantId: 'bank-c' });
    expect((await app.request('GET', `${base}/reservations`, { token: otherTenant })).status).toBe(
      404,
    );
    expect((await app.request('GET', `${base}/ledger`, { token: otherTenant })).status).toBe(404);
    expect((await app.request('GET', '/v1/programs/missing/ledger')).status).toBe(404);

    for (const query of ['cursor=not-a-cursor', 'limit=0', 'limit=101', 'status=NOPE']) {
      const response = await app.request('GET', `${base}/reservations?${query}`);
      expect(response.status).toBe(400);
      expect(response.body.type).toContain('validation-error');
    }
    expect((await app.request('GET', `${base}/ledger?cursor=bogus`)).status).toBe(400);

    const writeOnly = await app.token({ scope: 'capacity:write' });
    expect((await app.request('GET', `${base}/reservations`, { token: writeOnly })).status).toBe(
      403,
    );
    expect((await app.request('GET', `${base}/ledger`, { token: null })).status).toBe(401);
  });
});
