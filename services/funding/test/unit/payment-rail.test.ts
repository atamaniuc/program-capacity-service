import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpPaymentRail } from '../../src/funding/adapters/out/http/payment-rail.js';

interface Request {
  method: string;
  url: string;
  key: string | undefined;
  body: string;
}

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  server = undefined;
});

async function rail(
  answer: (request: Request, index: number) => { status: number; body?: unknown } | 'hang',
  timeoutMs = 2_000,
): Promise<{ rail: HttpPaymentRail; seen: Request[] }> {
  const seen: Request[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        key: req.headers['idempotency-key'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      const reply = answer(entry, seen.length - 1);
      if (reply === 'hang') return;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}`;
  return { rail: new HttpPaymentRail({ baseUrl, timeoutMs }), seen };
}

const call = (lookupFirst: boolean) => ({
  key: 'funding:r1:disburse',
  invoiceId: 'inv-1',
  amount: { minor: 125_050n, currency: 'USD' },
  lookupFirst,
});

describe('payment rail adapter (ADR 025)', () => {
  it('FS-03 posts the key and an integer-minor body; PAID is paid', async () => {
    const { rail: r, seen } = await rail(() => ({
      status: 201,
      body: { status: 'PAID', paymentId: 'pay-1' },
    }));
    expect(await r.disburse(call(false))).toEqual({ kind: 'paid', paymentId: 'pay-1' });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.key).toBe('funding:r1:disburse');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      invoiceId: 'inv-1',
      amountMinor: '125050',
      currency: 'USD',
    });
  });

  it('FS-06 a DECLINED answer is a definite failure', async () => {
    const { rail: r } = await rail(() => ({ status: 422, body: { status: 'DECLINED' } }));
    expect(await r.disburse(call(false))).toEqual({ kind: 'declined' });
  });

  it('FS-10 a timeout, a 5xx, a conflict and an unparseable answer are all unknown, never a guess', async () => {
    const { rail: hang } = await rail(() => 'hang', 200);
    expect(await hang.disburse(call(false))).toEqual({ kind: 'unknown' });
    const { rail: down } = await rail(() => ({ status: 503 }));
    expect(await down.disburse(call(false))).toEqual({ kind: 'unknown' });
    const { rail: conflict } = await rail(() => ({ status: 409, body: { title: 'reused' } }));
    expect(await conflict.disburse(call(false))).toEqual({ kind: 'unknown' });
    const { rail: junk } = await rail(() => ({ status: 200, body: 'nope' }));
    expect(await junk.disburse(call(false))).toEqual({ kind: 'unknown' });
  });

  it('FS-10 after an unknown attempt the lookup comes first; a stored payment is the answer without a second POST', async () => {
    const { rail: r, seen } = await rail(() => ({
      status: 200,
      body: { status: 'PAID', paymentId: 'pay-9' },
    }));
    expect(await r.disburse(call(true))).toEqual({ kind: 'paid', paymentId: 'pay-9' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /v1/payments/funding%3Ar1%3Adisburse',
    ]);
  });

  it('FS-10 a 404 on the lookup means nothing was committed: POST again with the same key and body', async () => {
    const { rail: r, seen } = await rail((request) =>
      request.method === 'GET'
        ? { status: 404 }
        : { status: 201, body: { status: 'PAID', paymentId: 'pay-2' } },
    );
    expect(await r.disburse(call(true))).toEqual({ kind: 'paid', paymentId: 'pay-2' });
    expect(seen.map((s) => s.method)).toEqual(['GET', 'POST']);
    expect(seen[1]?.key).toBe('funding:r1:disburse');
  });

  it('FS-07 every POST of a step carries identical bytes', async () => {
    const { rail: r, seen } = await rail((_request, index) =>
      index === 0 ? { status: 503 } : { status: 201, body: { status: 'PAID', paymentId: 'pay-3' } },
    );
    await r.disburse(call(false));
    await r.disburse(call(false));
    expect(seen[0]?.body).toBe(seen[1]?.body);
  });
});
