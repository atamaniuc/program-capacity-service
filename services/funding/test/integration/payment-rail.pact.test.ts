import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchersV3, PactV3, Verifier } from '@pact-foundation/pact';
import { expect, it } from 'vitest';
import { Rail } from '../../../payments-mock/src/rail.js';
import { createApiServer, listen } from '../../../payments-mock/src/server.js';
import { HttpPaymentRail } from '../../src/funding/adapters/out/http/payment-rail.js';

const consumer = 'funding-service';
const provider = 'payments-mock';
const paymentPath = '/v1/payments';
const samplePaymentId = '6c680c02-7749-4efa-8e06-2242b6d67565';
const paid = { kind: 'paid', paymentId: samplePaymentId };
const paidBody = { status: 'PAID', paymentId: MatchersV3.like(samplePaymentId) };

function request(invoiceId: string) {
  return { invoiceId, amountMinor: '125050', currency: 'USD' };
}

const storedState = 'a payment has already been recorded';
const storedKey = 'funding:stored:disburse';
const storedInvoice = 'inv-stored';

it('FS-03, FS-06, FS-07, FS-10 verify Funding payment expectations against the Payments Mock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'finverity-payment-pact-'));
  const rail = new Rail();
  const server = createApiServer(rail);

  try {
    const pact = new PactV3({ consumer, provider, dir, logLevel: 'error' });
    const payments = [
      {
        description: 'a new disbursement',
        key: 'funding:new:disburse',
        invoiceId: 'inv-new',
        response: { status: 201, body: paidBody },
        expected: paid,
      },
      {
        description: 'a repeated disbursement with the same request',
        key: storedKey,
        invoiceId: storedInvoice,
        response: { status: 200, body: paidBody },
        expected: paid,
      },
      {
        description: 'a definitively declined disbursement',
        key: 'funding:decline:disburse',
        invoiceId: 'FAULT-DECLINE-pact',
        response: { status: 422, body: { status: 'DECLINED' } },
        expected: { kind: 'declined' },
      },
      {
        description: 'a disbursement when the rail is temporarily unavailable',
        key: 'funding:unavailable:disburse',
        invoiceId: 'FAULT-5XX-1-pact',
        response: { status: 503 },
        expected: { kind: 'unknown' },
      },
    ];

    for (const { description, key, invoiceId, response } of payments) {
      if (key === storedKey) pact.given(storedState);
      pact
        .uponReceiving(description)
        .withRequest({
          method: 'POST',
          path: paymentPath,
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: request(invoiceId),
        })
        .willRespondWith(response);
    }

    pact
      .given(storedState)
      .uponReceiving('a lookup by the original key after an unknown result')
      .withRequest({ method: 'GET', path: `${paymentPath}/${encodeURIComponent(storedKey)}` })
      .willRespondWith({ status: 200, body: paidBody });

    await pact.executeTest(async ({ url }) => {
      const client = new HttpPaymentRail({ baseUrl: url, timeoutMs: 2_000 });
      const amount = { minor: 125_050n, currency: 'USD' };
      for (const { key, invoiceId, expected } of payments) {
        expect(await client.disburse({ key, invoiceId, amount, lookupFirst: false })).toEqual(
          expected,
        );
      }
      expect(
        await client.disburse({
          key: storedKey,
          invoiceId: storedInvoice,
          amount,
          lookupFirst: true,
        }),
      ).toEqual(paid);
    });

    const port = await listen(server, 0, '127.0.0.1');
    await new Verifier({
      provider,
      providerBaseUrl: `http://127.0.0.1:${port}`,
      pactUrls: [join(dir, `${consumer}-${provider}.json`)],
      stateHandlers: {
        [storedState]: () => {
          rail.post(storedKey, request(storedInvoice));
          return Promise.resolve();
        },
      },
    }).verifyProvider();
  } finally {
    try {
      if (server.listening) {
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        server.closeAllConnections();
        await closed;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
