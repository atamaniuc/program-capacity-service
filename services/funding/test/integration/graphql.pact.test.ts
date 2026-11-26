import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PactV3, Verifier } from '@pact-foundation/pact';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Rail } from '../../../payments-mock/src/rail.js';
import { createApiServer, listen } from '../../../payments-mock/src/server.js';
import { JwtVerifier } from '../../src/funding/adapters/in/http/auth.js';
import { createFundingGraphql } from '../../src/funding/adapters/in/http/graphql.js';
import { createHttpServer } from '../../src/funding/adapters/in/http/server.js';
import {
  CreateFundingRequest,
  GetFundingRequest,
} from '../../src/funding/application/funding-requests.js';
import type {
  FundingRequestRecord,
  FundingTransaction,
  UnitOfWork,
} from '../../src/funding/application/ports.js';
import { stepKey } from '../../src/funding/domain/keys.js';
import { startTestIssuer, type TestIssuer } from '../support/auth.js';

const { createEnrichmentServer } = (await import(
  new URL('../../../enrichment-mock/server.mjs', import.meta.url).href
)) as { createEnrichmentServer: (kind: 'invoice' | 'buyer') => Server };
const { recentQuery, createMutation } = (await import(
  new URL('../../../poc-ui/operations.mjs', import.meta.url).href
)) as { recentQuery: string; createMutation: string };

const ids = [
  'e74427b2-b7da-44d1-9200-b053c4cf2d6e',
  'adcb71c9-5e9e-42c8-acc1-001865a6ec24',
  'f28d0466-ef94-4e1f-ae2d-639e4f706ad1',
] as const;
const reservationId = '60eb9bde-8cfe-468c-9a32-2a7cfa0e9220';
const rail = new Rail();
const completed = ids.slice(0, 2).map((requestId, index): FundingRequestRecord => {
  const invoiceId = `INV-CONTRACT-${index + 1}`;
  const outcome = rail.post(stepKey(requestId, 'disburse'), {
    invoiceId,
    amountMinor: '125050',
    currency: 'USD',
  });
  if (outcome.kind !== 'created') throw new Error('Expected a payment fixture.');
  return {
    id: requestId,
    tenantId: 'bank-a',
    programId: 'prg_grand_usd',
    invoiceId,
    currency: 'USD',
    amountMinor: 125050n,
    state: 'COMPLETED',
    reason: null,
    reservationId,
    paymentId: outcome.payment.paymentId,
    createdAt: new Date('2026-11-25T10:00:00Z'),
  };
});
const created: FundingRequestRecord = {
  id: ids[2],
  tenantId: 'bank-a',
  programId: 'prg_grand_usd',
  invoiceId: 'INV-NEW',
  currency: 'USD',
  amountMinor: 3000n,
  state: 'RECEIVED',
  reason: null,
  reservationId: null,
  paymentId: null,
  createdAt: new Date('2026-11-25T11:00:00Z'),
};
const byIds = vi.fn((tenantId: string, requestIds: readonly string[]) =>
  Promise.resolve(
    completed.filter((record) => record.tenantId === tenantId && requestIds.includes(record.id)),
  ),
);
const transaction: FundingTransaction = {
  claimKey: () => Promise.resolve(true),
  findKey: () => Promise.resolve(null),
  completeKey: () => Promise.resolve(),
  findRequest: () => Promise.resolve(null),
  insertRequest: (row) => Promise.resolve({ record: { ...created, ...row }, created: true }),
  insertOutbox: () => Promise.resolve(),
};
const uow: UnitOfWork = { run: (work) => work(transaction) };
const servers: Server[] = [];
let issuer: TestIssuer;
let fundingUrl: string;
let authorization: string;

async function start(server: Server): Promise<string> {
  servers.push(server);
  return `http://127.0.0.1:${await listen(server, 0, '127.0.0.1')}`;
}

beforeAll(async () => {
  issuer = await startTestIssuer();
  authorization = `Bearer ${await issuer.sign({
    tenantId: 'bank-a',
    sub: 'poc-ui',
    scope: 'funding:read funding:write',
  })}`;
  const [invoiceUrl, buyerUrl, paymentUrl] = await Promise.all([
    start(createEnrichmentServer('invoice')),
    start(createEnrichmentServer('buyer')),
    start(createApiServer(rail)),
  ]);
  const create = new CreateFundingRequest(uow);
  fundingUrl = await start(
    createHttpServer({
      verifier: new JwtVerifier(issuer),
      create,
      get: new GetFundingRequest(uow),
      graphql: createFundingGraphql({
        create,
        reader: {
          byIds,
          recent: (tenantId, limit) =>
            Promise.resolve(
              completed.filter((record) => record.tenantId === tenantId).slice(0, limit),
            ),
        },
        invoiceUrl,
        buyerUrl,
        paymentUrl,
        onError: console.error,
      }),
    }),
  );
});

afterAll(async () => {
  await Promise.all([
    issuer?.close(),
    ...servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  ]);
});

const graphqlPath = '/graphql';
const headers = { 'content-type': 'application/json' };

function call(url: string, body: unknown, token = authorization): Promise<Response> {
  return fetch(`${url}${graphqlPath}`, {
    method: 'POST',
    headers: { ...headers, authorization: token },
    body: JSON.stringify(body),
  });
}

it('verifies the dashboard read and mutation against the Funding GraphQL provider with Pact', async () => {
  const consumer = 'funding-poc-dashboard';
  const provider = 'funding-graphql';
  const dir = await mkdtemp(join(tmpdir(), 'finverity-graphql-pact-'));
  const inputs = {
    input: {
      programId: created.programId,
      invoiceId: created.invoiceId,
      amount: { value: '30.00', currency: 'USD' },
    },
    key: 'pact-new-funding-request',
  };
  const interactions = [
    {
      label: 'recent funding requests with invoice, buyer and payment details',
      request: { query: recentQuery, operationName: 'RecentFundingRequests' },
      expected: {
        data: {
          recentFundingRequests: completed.map((row) => ({
            id: row.id,
            programId: row.programId,
            invoiceId: row.invoiceId,
            state: row.state,
            reason: row.reason,
            reservationId: row.reservationId,
            paymentId: row.paymentId,
            amount: { value: '1250.50', currency: 'USD' },
            invoice: { id: row.invoiceId, description: 'Early supplier payment' },
            buyer: { name: 'Grand Trading Company', region: 'Europe' },
            payment: { status: 'PAID' },
          })),
        },
        extensions: {
          batches: { fundingDb: 1, invoiceHttp: 1, buyerHttp: 1, paymentHttp: 1 },
        },
      },
    },
    {
      label: 'the dashboard submitting a funding request',
      request: { query: createMutation, operationName: 'RunScenario', variables: inputs },
      expected: { data: { createFundingRequest: { id: created.id, state: 'RECEIVED' } } },
    },
  ];

  try {
    const pact = new PactV3({ consumer, provider, dir, logLevel: 'error' });
    for (const { label, request, expected } of interactions) {
      pact
        .uponReceiving(label)
        .withRequest({
          method: 'POST',
          path: graphqlPath,
          headers: { ...headers, authorization },
          body: request,
        })
        .willRespondWith({ status: 200, headers, body: expected });
    }
    await pact.executeTest(async ({ url }) => {
      for (const { request, expected } of interactions) {
        const response = await call(url, request);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      }
    });
    await new Verifier({
      provider,
      providerBaseUrl: fundingUrl,
      pactUrls: [join(dir, `${consumer}-${provider}.json`)],
      logLevel: 'error',
    }).verifyProvider();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('batches aliases and repeated IDs with tenant-scoped cache and ordered nullable results', async () => {
  byIds.mockClear();
  const request = {
    query: `query Batched($ids: [ID!]!, $id: ID!) {
      ordered: fundingRequests(ids: $ids) { id invoice { id } buyer { id } payment { status } }
      alias: fundingRequest(id: $id) { id }
    }`,
    variables: { ids: [ids[1], ids[2], ids[0], ids[1]], id: ids[0] },
  };
  const first = await call(fundingUrl, request);
  const result = await first.json();
  expect(result).toMatchObject({
    data: {
      ordered: [{ id: ids[1] }, null, { id: ids[0] }, { id: ids[1] }],
      alias: { id: ids[0] },
    },
    extensions: { batches: { fundingDb: 1, invoiceHttp: 1, buyerHttp: 1, paymentHttp: 1 } },
  });
  expect(result).not.toHaveProperty('errors');
  expect(byIds.mock.calls).toEqual([['bank-a', [ids[1], ids[2], ids[0]]]]);

  const bankB = await issuer.sign({ tenantId: 'bank-b', sub: 'bank-b', scope: 'funding:read' });
  const second = await call(fundingUrl, request, `Bearer ${bankB}`);
  expect(await second.json()).toMatchObject({
    data: { ordered: [null, null, null, null], alias: null },
    extensions: { batches: { fundingDb: 1, invoiceHttp: 0, buyerHttp: 0, paymentHttp: 0 } },
  });
  expect(byIds.mock.calls).toHaveLength(2);
  expect(byIds).toHaveBeenLastCalledWith('bank-b', [ids[1], ids[2], ids[0]]);
});

it('requires bearer authentication and read scope before any data lookup', async () => {
  const query = { query: recentQuery };
  expect((await call(fundingUrl, query, '')).status).toBe(401);
  const writeOnly = await issuer.sign({
    tenantId: 'bank-a',
    sub: 'writer',
    scope: 'funding:write',
  });
  const forbidden = await call(fundingUrl, query, `Bearer ${writeOnly}`);
  expect(await forbidden.json()).toMatchObject({
    errors: [{ extensions: { code: 'FORBIDDEN' } }],
    extensions: { batches: { fundingDb: 0, invoiceHttp: 0, buyerHttp: 0, paymentHttp: 0 } },
  });
});
