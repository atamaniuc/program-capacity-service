import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

async function seed(app: TestApp, tenantId: string, id: string, limit: string): Promise<void> {
  await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
            VALUES (${tenantId}, ${id}, 'USD', ${limit}::bigint)`.execute(app.persistence.db);
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe('auth', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
    await seed(app, 'bank-b', 'b-only', '100000');
    await seed(app, 'bank-a', 'grand-usd', '100000000');
    await seed(app, 'bank-b', 'grand-usd', '100000000');
  });

  afterAll(async () => {
    await app.stop();
  });

  const reserveBody = { invoiceId: 'INV-1', amount: { value: '1000.00', currency: 'USD' } };

  it('AC-13 answers 404 for another tenant program, 403 without write scope, 401 without a token', async () => {
    const readOnly = await app.token({ scope: 'capacity:read' });

    const crossTenant = await app.request('GET', '/v1/programs/b-only/capacity', {
      token: readOnly,
    });
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.headers.get('content-type')).toContain('application/problem+json');
    expect(crossTenant.body).toMatchObject({
      type: 'https://errors.capacity.example/not-found',
      status: 404,
    });

    const ownProgram = await app.request('GET', '/v1/programs/grand-usd/capacity', {
      token: readOnly,
    });
    expect(ownProgram.status).toBe(200);

    const forbidden = await app.request('POST', '/v1/programs/grand-usd/reservations', {
      token: readOnly,
      body: reserveBody,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ type: 'https://errors.capacity.example/forbidden' });

    const anonymous = await app.request('GET', '/v1/programs/grand-usd/capacity', { token: null });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    expect(anonymous.headers.get('content-type')).toContain('application/problem+json');
    expect(anonymous.body).toMatchObject({ type: 'https://errors.capacity.example/unauthorized' });
  });

  it('AC-13 answers 403 for a read call carrying only the write scope', async () => {
    const writeOnly = await app.token({ scope: 'capacity:write' });
    const response = await app.request('GET', '/v1/programs/grand-usd/capacity', {
      token: writeOnly,
    });
    expect(response.status).toBe(403);
  });

  it('AC-13 answers 401 for a bad signature, expiry, issuer, audience or missing claims', async () => {
    const rejected = [
      await app.issuer.sign(
        { tenantId: 'bank-a', scope: 'capacity:read', sub: 's' },
        { signWithOtherKey: true },
      ),
      await app.token({ expiresIn: nowSeconds() - 120 }),
      await app.token({ issuer: 'https://evil.example' }),
      await app.token({ audience: 'another-service' }),
      await app.issuer.sign({ scope: 'capacity:read', sub: 's' }),
      await app.issuer.sign({ tenantId: 'bank-a', sub: 's' }),
      await app.issuer.sign({ tenantId: 'bank-a', scope: 'capacity:read' }),
      'not-a-jwt',
    ];
    for (const token of rejected) {
      const response = await app.request('GET', '/v1/programs/grand-usd/capacity', { token });
      expect(response.status).toBe(401);
    }
  });

  it('AC-13 accepts a client_id as the actor when sub is absent and tolerates small clock skew', async () => {
    const token = await app.issuer.sign({
      tenantId: 'bank-a',
      scope: 'capacity:read',
      clientId: 'client-1',
      expiresIn: nowSeconds() - 10,
    });
    const response = await app.request('GET', '/v1/programs/grand-usd/capacity', { token });
    expect(response.status).toBe(200);
  });

  it('AC-16 changes only the calling tenant program when two tenants share a program id', async () => {
    const reserve = await app.request('POST', '/v1/programs/grand-usd/reservations', {
      body: reserveBody,
    });
    expect(reserve.status).toBe(201);

    const a = await app.request('GET', '/v1/programs/grand-usd/capacity');
    const b = await app.request('GET', '/v1/programs/grand-usd/capacity', {
      token: await app.token({ tenantId: 'bank-b' }),
    });
    expect(a.body).toMatchObject({ reserved: '1000.00', version: 1 });
    expect(b.body).toMatchObject({ reserved: '0.00', version: 0 });

    const { rows } = await sql<{ tenant_id: string; reserved_minor: string }>`
      SELECT tenant_id, reserved_minor::text FROM program WHERE id = 'grand-usd' ORDER BY tenant_id`.execute(
      app.persistence.db,
    );
    expect(rows).toEqual([
      { tenant_id: 'bank-a', reserved_minor: '100000' },
      { tenant_id: 'bank-b', reserved_minor: '0' },
    ]);

    const ledger = await sql<{ actor: string; tenant_id: string }>`
      SELECT actor, tenant_id FROM ledger_entry`.execute(app.persistence.db);
    expect(ledger.rows).toEqual([{ actor: 'svc-orders', tenant_id: 'bank-a' }]);
  });
});
