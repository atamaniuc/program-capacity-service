import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSystemStack, type SystemStack } from '../support/system-stack.js';

let stack: SystemStack;

beforeAll(async () => {
  stack = await startSystemStack();
  await stack.seedProgram({
    tenantId: 'bank-a',
    id: 'prg_sys',
    currency: 'USD',
    limitMinor: 10_000_000_00n,
  });
}, 600_000);

afterAll(async () => {
  await stack?.close();
}, 120_000);

describe('saga against the real capacity image and the payments mock', () => {
  it('FS-03 a funding request reaches COMPLETED; capacity holds one reservation by funding-service; the rail holds one payment', async () => {
    const id = await stack.submit({
      tenantId: 'bank-a',
      programId: 'prg_sys',
      invoiceId: 'inv-sys-1',
      value: '1250.50',
    });
    await stack.drain(stack.driver());

    const [row] = await stack.funding('SELECT * FROM funding_request WHERE id = $1', [id]);
    expect(row?.['state']).toBe('COMPLETED');

    const reservations = await stack.capacity(
      `SELECT id::text, amount_minor::text, status FROM reservation WHERE tenant_id = 'bank-a' AND invoice_id = 'inv-sys-1'`,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.['id']).toBe(row?.['reservation_id']);
    expect(reservations[0]?.['amount_minor']).toBe('125050');
    const ledger = await stack.capacity(
      `SELECT kind, actor, delta_reserved_minor::text FROM ledger_entry WHERE reservation_id = $1::uuid ORDER BY id`,
      [reservations[0]?.['id']],
    );
    expect(ledger).toEqual([
      { kind: 'RESERVE', actor: 'funding-service.bank-a', delta_reserved_minor: '125050' },
    ]);
    const [program] = await stack.capacity(
      `SELECT reserved_minor::text FROM program WHERE tenant_id = 'bank-a' AND id = 'prg_sys'`,
    );
    expect(program?.['reserved_minor']).toBe('125050');

    const payment = await fetch(
      `${stack.paymentsUrl}/v1/payments/${encodeURIComponent(`funding:${id}:disburse`)}`,
    );
    expect(payment.status).toBe(200);
    expect(await payment.json()).toMatchObject({
      status: 'PAID',
      invoiceId: 'inv-sys-1',
      amountMinor: '125050',
    });
    expect(row?.['payment_id']).toBeTruthy();

    const outbox = await stack.funding(
      'SELECT type FROM outbox_event WHERE request_id = $1 ORDER BY created_at, id',
      [id],
    );
    expect(outbox.map((o) => o['type'])).toEqual([
      'FundingRequestReceived',
      'FundingRequestCompleted',
    ]);
  }, 120_000);

  it('FS-02 the mock mints aud funding-service for a funding API client, capacity for the rest (review M1)', async () => {
    const api = await stack.mint({
      client_id: 'bank-a',
      client_secret: 's',
      scope: 'funding:write funding:read',
    });
    expect([api['aud']].flat()).toEqual(['funding-service']);
    expect(api['tenant_id']).toBe('bank-a');
    expect(api['scope']).toBe('funding:write funding:read');
    const plain = await stack.mint({
      client_id: 'bank-a',
      client_secret: 's',
      scope: 'capacity:read',
    });
    expect([plain['aud']].flat()).toEqual(['capacity-service']);
  }, 60_000);

  it('FS-03 the per-tenant capacity client carries the tenant_id claim only when the form sends it (review m4)', async () => {
    const withTenant = await stack.mint({
      client_id: 'funding-service.bank-a',
      client_secret: 's',
      scope: 'capacity:write',
      tenant_id: 'bank-a',
    });
    expect([withTenant['aud']].flat()).toEqual(['capacity-service']);
    expect(withTenant['tenant_id']).toBe('bank-a');
    const without = await stack.mint({
      client_id: 'funding-service.bank-a',
      client_secret: 's',
      scope: 'capacity:write',
    });
    expect(without['tenant_id']).not.toBe('bank-a');
  }, 60_000);
});
