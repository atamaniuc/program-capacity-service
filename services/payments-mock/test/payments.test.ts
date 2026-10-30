import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rail } from '#src/rail.js';
import { createApiServer, createOpsServer, listen } from '#src/server.js';

let api: Server;
let ops: Server;
let base: string;
let opsBase: string;

beforeAll(async () => {
  api = createApiServer(new Rail());
  ops = createOpsServer();
  base = `http://127.0.0.1:${await listen(api, 0, '127.0.0.1')}`;
  opsBase = `http://127.0.0.1:${await listen(ops, 0, '127.0.0.1')}`;
});

afterAll(async () => {
  api.closeAllConnections();
  await Promise.all([api, ops].map((s) => new Promise((r) => s.close(r))));
});

const body = (invoiceId: string, amountMinor = '1000') =>
  JSON.stringify({ invoiceId, amountMinor, currency: 'EUR' });

const post = (key: string, payload: string, signal?: AbortSignal) =>
  fetch(`${base}/v1/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });

describe('payments mock', () => {
  it('PM-01 one payment per key; the second post replays it and GET returns it', async () => {
    const first = await post('k-1', body('inv-1'));
    const second = await post('k-1', body('inv-1'));
    const created = (await first.json()) as { paymentId: string; status: string };
    const replayed = (await second.json()) as { paymentId: string };
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(replayed.paymentId).toBe(created.paymentId);
    expect(created.status).toBe('PAID');
    const got = await fetch(`${base}/v1/payments/k-1`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { paymentId: string }).paymentId).toBe(created.paymentId);
    expect((await fetch(`${base}/v1/payments/unknown`)).status).toBe(404);
  });

  it('PM-01 the same key with another body is a conflict and stores nothing new', async () => {
    await post('k-2', body('inv-2'));
    const other = await post('k-2', body('inv-2', '2000'));
    expect(other.status).toBe(409);
    const stored = (await (await fetch(`${base}/v1/payments/k-2`)).json()) as {
      amountMinor: string;
    };
    expect(stored.amountMinor).toBe('1000');
  });

  it('PM-01 a request without a key or with a bad body is refused', async () => {
    const noKey = await fetch(`${base}/v1/payments`, { method: 'POST', body: body('inv-3') });
    expect(noKey.status).toBe(400);
    expect(
      (await post('k-3', '{"invoiceId":"x","amountMinor":"1.5","currency":"EUR"}')).status,
    ).toBe(400);
  });

  it('PM-01 FAULT-DECLINE is a definite decline, stored and replayed', async () => {
    const first = await post('k-4', body('FAULT-DECLINE-1'));
    expect(first.status).toBe(422);
    expect(((await first.json()) as { status: string }).status).toBe('DECLINED');
    expect((await post('k-4', body('FAULT-DECLINE-1'))).status).toBe(422);
    expect(
      ((await (await fetch(`${base}/v1/payments/k-4`)).json()) as { status: string }).status,
    ).toBe('DECLINED');
  });

  it('PM-01 FAULT-5XX-2 answers 503 twice with nothing committed, then succeeds', async () => {
    expect((await post('k-5', body('FAULT-5XX-2'))).status).toBe(503);
    expect((await fetch(`${base}/v1/payments/k-5`)).status).toBe(404);
    expect((await post('k-5', body('FAULT-5XX-2'))).status).toBe(503);
    expect((await post('k-5', body('FAULT-5XX-2'))).status).toBe(201);
    expect((await post('k-5', body('FAULT-5XX-2'))).status).toBe(200);
  });

  it('PM-01 FAULT-TIMEOUT commits the payment and never answers; a retry gets the stored one', async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 300);
    await expect(post('k-6', body('FAULT-TIMEOUT-1'), abort.signal)).rejects.toThrow();
    clearTimeout(timer);
    const committed = await fetch(`${base}/v1/payments/k-6`);
    expect(committed.status).toBe(200);
    const retry = await post('k-6', body('FAULT-TIMEOUT-1'));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { paymentId: string }).paymentId).toBe(
      ((await committed.json()) as { paymentId: string }).paymentId,
    );
  });

  it('PM-01 the ops port answers liveness', async () => {
    const live = await fetch(`${opsBase}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'up' });
  });
});
