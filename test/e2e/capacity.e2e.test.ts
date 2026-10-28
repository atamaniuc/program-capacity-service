/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- response bodies are parsed JSON */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';

describe('capacity over HTTP', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor, reserved_minor)
              VALUES ('bank-a', 'prg_grand_usd', 'USD', 1000000000, 0),
                     ('bank-a', 'cut', 'USD', 300000000, 362000000)`.execute(app.persistence.db);
    await sql`INSERT INTO fx_rate (base, quote, rate, source, as_of)
              VALUES ('EUR', 'USD', 1.08, 'treasury', now())`.execute(app.persistence.db);
  });

  afterAll(async () => {
    await app.stop();
  });

  const path = '/v1/programs/prg_grand_usd';

  it('FR-01 reads limit, reserved, available, overLimitBy, utilization, version and treasurySeq with an ETag', async () => {
    const response = await app.request('GET', `${path}/capacity`);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"0"');
    expect(response.body).toEqual({
      programId: 'prg_grand_usd',
      currency: 'USD',
      limit: '10000000.00',
      reserved: '0.00',
      available: '10000000.00',
      overLimitBy: '0.00',
      utilization: '0.0000',
      version: 0,
      treasurySeq: 0,
    });

    const notModified = await app.request('GET', `${path}/capacity`, {
      headers: { 'if-none-match': '"0"' },
    });
    expect(notModified.status).toBe(304);

    const cut = await app.request('GET', '/v1/programs/cut/capacity');
    expect(cut.body).toMatchObject({
      available: '0.00',
      overLimitBy: '620000.00',
      utilization: '1.2066',
    });
    expect((await app.request('GET', '/v1/programs/missing/capacity')).status).toBe(404);
  });

  it('FR-01 a reserve is visible to the next read (reads go to the primary) and the ETag follows the version', async () => {
    const created = await app.request('POST', `${path}/reservations`, {
      headers: { 'idempotency-key': '6f1c0e2a-9d7b-4c1e-8a55-0b3c2f1d7e90' },
      body: { invoiceId: 'INV-1003', amount: { value: '1000000.00', currency: 'EUR' } },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('content-type')).toContain('application/json');
    expect(created.headers.get('location')).toBe(
      `${path}/reservations/${created.body.reservationId}`,
    );
    expect(created.body).toMatchObject({
      status: 'ACTIVE',
      invoiceAmount: { value: '1000000.00', currency: 'EUR' },
      reservedAmount: { value: '1080000.00', currency: 'USD' },
      fx: { rate: '1.0800000000', source: 'treasury' },
      capacity: {
        limit: '10000000.00',
        reserved: '1080000.00',
        available: '8920000.00',
        version: 1,
      },
    });

    const capacity = await app.request('GET', `${path}/capacity`);
    expect(capacity.headers.get('etag')).toBe('"1"');
    expect(capacity.body).toMatchObject({ reserved: '1080000.00', utilization: '0.1080' });

    const replay = await app.request('POST', `${path}/reservations`, {
      headers: { 'idempotency-key': '6f1c0e2a-9d7b-4c1e-8a55-0b3c2f1d7e90' },
      body: { amount: { currency: 'EUR', value: '1000000.00' }, invoiceId: 'INV-1003' },
    });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created.body);
  });

  it('FR-02 maps outcomes: 200 replay, 409 conflict, 422 insufficient capacity, 422 key mismatch', async () => {
    const body = { invoiceId: 'INV-1003', amount: { value: '1000000.00', currency: 'EUR' } };
    expect((await app.request('POST', `${path}/reservations`, { body })).status).toBe(200);

    const conflict = await app.request('POST', `${path}/reservations`, {
      body: { ...body, amount: { value: '999999.99', currency: 'EUR' } },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.type).toBe('https://errors.capacity.example/reservation-conflict');

    const tooBig = await app.request('POST', `${path}/reservations`, {
      body: { invoiceId: 'INV-HUGE', amount: { value: '99999999.00', currency: 'USD' } },
    });
    expect(tooBig.status).toBe(422);
    expect(tooBig.headers.get('content-type')).toContain('application/problem+json');
    expect(tooBig.body).toMatchObject({
      type: 'https://errors.capacity.example/insufficient-capacity',
      title: 'Insufficient capacity',
      status: 422,
    });

    const mismatch = await app.request('POST', `${path}/reservations`, {
      headers: { 'idempotency-key': '6f1c0e2a-9d7b-4c1e-8a55-0b3c2f1d7e90' },
      body: { invoiceId: 'INV-OTHER', amount: { value: '1.00', currency: 'USD' } },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.type).toBe('https://errors.capacity.example/idempotency-key-mismatch');
  });

  it('FR-02 answers 400 validation-error for malformed bodies without internals', async () => {
    const cases: unknown[] = [
      {},
      { invoiceId: 'I', amount: { value: '10.5', currency: 'USD' } },
      { invoiceId: 'I', amount: { value: '-10.00', currency: 'USD' } },
      { invoiceId: 'I', amount: { value: '1e3', currency: 'USD' } },
      { invoiceId: 'I', amount: { value: '10.00', currency: 'XXX' } },
      { invoiceId: 'I', amount: { value: '10', currency: 'JPY' }, extra: true },
      { invoiceId: '', amount: { value: '10.00', currency: 'USD' } },
    ];
    for (const body of cases) {
      const response = await app.request('POST', `${path}/reservations`, { body });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.body).toMatchObject({
        type: 'https://errors.capacity.example/validation-error',
        status: 400,
      });
      expect(JSON.stringify(response.body)).not.toMatch(/at \w+|node_modules|\.ts/);
    }
    const zero = await app.request('POST', `${path}/reservations`, {
      body: { invoiceId: 'I', amount: { value: '0.00', currency: 'USD' } },
    });
    expect(zero.status).toBe(400);
    const badJson = await app.request('POST', `${path}/reservations`, { rawBody: '{not json' });
    expect(badJson.status).toBe(400);
    expect(badJson.headers.get('content-type')).toContain('application/problem+json');
    const badKey = await app.request('POST', `${path}/reservations`, {
      headers: { 'idempotency-key': 'has space' },
      body: { invoiceId: 'I', amount: { value: '10.00', currency: 'USD' } },
    });
    expect(badKey.status).toBe(400);
  });

  it('FR-03 releases partially then fully over HTTP and reads the reservation with its releases', async () => {
    const created = await app.request('POST', `${path}/reservations`, {
      body: { invoiceId: 'INV-REL', amount: { value: '100.00', currency: 'EUR' } },
    });
    const id = created.body.reservationId as string;
    const base = `${path}/reservations/${id}`;

    const first = await app.request('POST', `${base}/releases`, {
      body: { releaseRef: 'r1', amount: { value: '40.00', currency: 'EUR' }, reason: 'REPAID' },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      reservationStatus: 'PARTIALLY_RELEASED',
      releasedAmount: { value: '43.20', currency: 'USD' },
      remainingAmount: { value: '64.80', currency: 'USD' },
    });

    const above = await app.request('POST', `${base}/releases`, {
      body: { releaseRef: 'r2', amount: { value: '60.01', currency: 'EUR' }, reason: 'REPAID' },
    });
    expect(above.status).toBe(422);
    expect(above.body.type).toBe('https://errors.capacity.example/release-exceeds-remaining');

    const mismatch = await app.request('POST', `${base}/releases`, {
      body: { releaseRef: 'r1', amount: { value: '41.00', currency: 'EUR' }, reason: 'REPAID' },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.type).toBe('https://errors.capacity.example/release-ref-mismatch');

    const last = await app.request('POST', `${base}/releases`, {
      headers: { 'idempotency-key': 'release-key-1' },
      body: { releaseRef: 'r3', reason: 'CANCELLED' },
    });
    expect(last.status).toBe(200);
    expect(last.body).toMatchObject({
      reservationStatus: 'RELEASED',
      releasedAmount: { value: '64.80', currency: 'USD' },
      remainingAmount: { value: '0.00' },
    });

    const detail = await app.request('GET', base);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      reservationId: id,
      status: 'RELEASED',
      reservedAmount: { value: '108.00' },
      releasedAmount: { value: '108.00' },
    });
    expect(detail.body.releases.map((r: { releaseRef: string }) => r.releaseRef)).toEqual([
      'r1',
      'r3',
    ]);

    expect(
      (await app.request('GET', `${path}/reservations/00000000-0000-7000-8000-000000000000`))
        .status,
    ).toBe(404);
    expect((await app.request('GET', `${path}/reservations/not-a-uuid`)).status).toBe(404);
    expect(
      (await app.request('POST', `${base}/releases`, { body: { releaseRef: 'x', reason: 'GIFT' } }))
        .status,
    ).toBe(400);
  });

  it('FR-01 does not expose ops endpoints or internals on the business port', async () => {
    const response = await app.request('GET', '/metrics', { token: null });
    expect(response.status).toBe(404);
  });
});
