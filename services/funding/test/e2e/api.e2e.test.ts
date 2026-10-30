import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateFundingRequest,
  GetFundingRequest,
} from '#src/funding/application/funding-requests.js';
import { JwtVerifier } from '#src/funding/adapters/in/http/auth.js';
import { boundPort, createHttpServer } from '#src/funding/adapters/in/http/server.js';
import { createPersistence, type Persistence } from '#src/funding/adapters/out/postgres/db.js';
import { migrate } from '#src/funding/adapters/out/postgres/migrate.js';
import { PostgresUnitOfWork } from '#src/funding/adapters/out/postgres/unit-of-work.js';
import { startTestIssuer, type TestIssuer } from '../support/auth.js';
import { startFundingPostgres, type FundingPostgres } from '../support/postgres.js';

let postgres: FundingPostgres;
let persistence: Persistence;
let issuer: TestIssuer;
let server: Server;
let base: string;

beforeAll(async () => {
  postgres = await startFundingPostgres();
  await migrate(postgres.fundingUrl);
  persistence = createPersistence(postgres.fundingUrl);
  issuer = await startTestIssuer('funding-service');
  const uow = new PostgresUnitOfWork(persistence);
  server = createHttpServer({
    verifier: new JwtVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      jwksUrl: issuer.jwksUrl,
    }),
    create: new CreateFundingRequest(uow),
    get: new GetFundingRequest(uow),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${boundPort(server).toString()}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await issuer.close();
  await persistence.close();
  await postgres.stop();
});

const token = (tenantId: string, scope = 'funding:write funding:read') =>
  issuer.sign({ tenantId, scope, sub: `client-${tenantId}` });

const body = (invoiceId: string, value = '1250.50') => ({
  programId: 'prg_1',
  invoiceId,
  amount: { value, currency: 'USD' },
});

async function post(
  bearer: string | undefined,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/v1/funding-requests`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function count(invoiceId: string): Promise<number> {
  const rows = await persistence.pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM funding_request WHERE invoice_id = $1',
    [invoiceId],
  );
  return Number(rows.rows[0]?.n);
}

describe('funding API', () => {
  it('FS-02 202 with Location and state RECEIVED, and the outbox row commits with it', async () => {
    const response = await post(await token('t1'), body('inv-1'));
    expect(response.status).toBe(202);
    const created = (await response.json()) as {
      id: string;
      state: string;
      amount: { value: string };
    };
    expect(created.state).toBe('RECEIVED');
    expect(created.amount.value).toBe('1250.50');
    expect(response.headers.get('location')).toBe(`/v1/funding-requests/${created.id}`);
    const outbox = await persistence.pool.query<{ type: string }>(
      'SELECT type FROM outbox_event WHERE request_id = $1',
      [created.id],
    );
    expect(outbox.rows.map((r) => r.type)).toEqual(['FundingRequestReceived']);

    const read = await fetch(`${base}/v1/funding-requests/${created.id}`, {
      headers: { authorization: `Bearer ${await token('t1')}` },
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(created);
  });

  it('FS-02 the same body with the same Idempotency-Key replays; 20 concurrent calls create one row', async () => {
    const bearer = await token('t1');
    const first = await post(bearer, body('inv-2'), { 'idempotency-key': 'k-2' });
    const replay = await post(bearer, body('inv-2'), { 'idempotency-key': 'k-2' });
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.headers.get('location')).toBe(first.headers.get('location'));
    expect(await replay.json()).toEqual(await first.json());

    const burst = await Promise.all(
      Array.from({ length: 20 }, () => post(bearer, body('inv-3'), { 'idempotency-key': 'k-3' })),
    );
    expect(new Set(burst.map((r) => r.status))).toEqual(new Set([202]));
    expect(new Set(burst.map((r) => r.headers.get('location'))).size).toBe(1);
    expect(await count('inv-3')).toBe(1);
  });

  it('FS-02 a different body with the key answers 422 idempotency-key-mismatch', async () => {
    const bearer = await token('t1');
    await post(bearer, body('inv-4'), { 'idempotency-key': 'k-4' });
    const response = await post(bearer, body('inv-4', '99.00'), { 'idempotency-key': 'k-4' });
    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(((await response.json()) as { type: string }).type).toBe(
      'https://errors.funding.example/idempotency-key-mismatch',
    );
  });

  it('FS-02 a second request for the same invoice without a key answers 200 with the existing one, 409 with other terms', async () => {
    const bearer = await token('t1');
    const first = await post(bearer, body('inv-5'));
    const again = await post(bearer, body('inv-5'));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(
      ((await first.json()) as { id: string }).id,
    );
    const other = await post(bearer, body('inv-5', '10.00'));
    expect(other.status).toBe(409);
    expect(((await other.json()) as { type: string }).type).toBe(
      'https://errors.funding.example/funding-request-conflict',
    );
    expect(await count('inv-5')).toBe(1);
  });

  it("FS-02 another tenant's request answers 404, the same invoice is a separate request there", async () => {
    const created = (await (await post(await token('t1'), body('inv-6'))).json()) as { id: string };
    const foreign = await fetch(`${base}/v1/funding-requests/${created.id}`, {
      headers: { authorization: `Bearer ${await token('t2')}` },
    });
    expect(foreign.status).toBe(404);
    const other = await post(await token('t2'), body('inv-6'));
    expect(other.status).toBe(202);
    expect(((await other.json()) as { id: string }).id).not.toBe(created.id);
  });

  it('FS-02 no token answers 401, a read scope on POST answers 403, a wrong audience 401', async () => {
    const none = await post(undefined, body('inv-7'));
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    const readOnly = await post(await token('t1', 'funding:read'), body('inv-7'));
    expect(readOnly.status).toBe(403);
    const wrongAudience = await post(
      await issuer.sign({
        tenantId: 't1',
        scope: 'funding:write',
        sub: 'c',
        audience: 'capacity-service',
      }),
      body('inv-7'),
    );
    expect(wrongAudience.status).toBe(401);
    const writeOnlyRead = await fetch(
      `${base}/v1/funding-requests/00000000-0000-4000-8000-000000000000`,
      {
        headers: { authorization: `Bearer ${await token('t1', 'funding:write')}` },
      },
    );
    expect(writeOnlyRead.status).toBe(403);
    expect(await count('inv-7')).toBe(0);
  });

  it('FS-02 invalid bodies answer 400 validation-error and store nothing', async () => {
    const bearer = await token('t1');
    for (const payload of [
      '{not json',
      { ...body('inv-8'), extra: 1 },
      body('inv-8', '12.5'),
      body('inv-8', '0.00'),
      { programId: 'p', invoiceId: 'inv-8', amount: { value: '1.00', currency: 'ZZZ' } },
    ]) {
      const response = await post(bearer, payload, { 'idempotency-key': 'k-8' });
      expect(response.status).toBe(400);
    }
    expect(await count('inv-8')).toBe(0);
    const stored = await persistence.pool.query('SELECT 1 FROM idempotency_key WHERE key = $1', [
      'k-8',
    ]);
    expect(stored.rowCount).toBe(0);
  });

  it('FS-02 a malformed id answers 404', async () => {
    const response = await fetch(`${base}/v1/funding-requests/not-a-uuid`, {
      headers: { authorization: `Bearer ${await token('t1')}` },
    });
    expect(response.status).toBe(404);
  });
});
