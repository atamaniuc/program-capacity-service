import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pact, Verifier } from '@pact-foundation/pact';
import { Registry } from 'prom-client';
import { expect, it } from 'vitest';
import { createGrpcServer } from '../../../../src/capacity/adapters/in/grpc/server.js';
import { succeeded } from '../../../../src/capacity/application/shared/problem.js';
import type {
  ReleaseView,
  ReservationView,
} from '../../../../src/capacity/application/shared/views.js';
import { GrpcCapacityGateway } from '../../src/funding/adapters/out/grpc/capacity-gateway.js';

const plugin = { plugin: 'protobuf', version: '0.8.1' };
const pluginDir = process.env.PACT_PLUGIN_DIR ?? join(homedir(), '.pact', 'plugins');
const host = '127.0.0.1';
const proto = fileURLToPath(
  new URL(
    '../../../../packages/contracts/proto/finverity/capacity/v1/capacity_service.proto',
    import.meta.url,
  ),
);
const consumer = 'Funding';
const provider = 'Capacity';
const token = 'pact-capacity-token';
const tenantId = 'bank-a';
const programId = 'grand-usd';
const invoiceId = 'INV-PACT';
const reservationId = '0193f514-7d11-7d91-9cd1-004146ea116a';
const releaseRef = 'funding:pact:compensation';
const reserveKey = 'funding:pact:reserve';
const releaseKey = 'funding:pact:release';
const usd = (value: string) => ({ value, currency: 'USD' });

function contract(method: string, key: string, request: unknown, response: unknown): string {
  return JSON.stringify({
    'pact:proto': proto,
    'pact:proto-service': `CapacityService/${method}`,
    'pact:content-type': 'application/grpc',
    requestMetadata: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    request,
    response,
  });
}

const gatewayAt = (port: number) =>
  new GrpcCapacityGateway({
    target: `${host}:${port}`,
    deadlineMs: 2000,
    tokens: { tokenFor: async () => token, invalidate: () => undefined },
  });

it.runIf(
  process.env.PACT_PLUGIN_DIR !== undefined ||
    existsSync(join(pluginDir, `protobuf-${plugin.version}`, 'pact-plugin.json')),
)(
  'CT-02/CT-03 Funding Reserve and compensation Release match the Capacity gRPC adapter',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'capacity-pact-'));
    const snapshot = { limit: '2000.00', reserved: '1000.00', available: '1000.00', version: 1 };
    const createdAt = '2026-10-31T12:00:00.000Z';
    const reserveView: ReservationView = {
      reservationId,
      invoiceId,
      status: 'ACTIVE',
      invoiceAmount: usd('1000.00'),
      reservedAmount: usd('1000.00'),
      releasedAmount: usd('0.00'),
      remainingAmount: usd('1000.00'),
      fx: { rate: '1.0000000000', source: 'identity', asOf: createdAt },
      createdAt,
      capacity: snapshot,
    };
    const releaseView: ReleaseView = {
      reservationId,
      releaseRef,
      reservationStatus: 'RELEASED',
      reason: 'CANCELLED',
      invoiceAmount: usd('1000.00'),
      releasedAmount: usd('1000.00'),
      remainingAmount: usd('0.00'),
      capacity: { ...snapshot, reserved: '0.00', available: '2000.00', version: 2 },
    };
    const server = createGrpcServer({
      verifier: {
        authenticate: async (header) => {
          expect(header).toBe(`Bearer ${token}`);
          return { tenantId, actor: consumer, scopes: new Set(['capacity:write']) };
        },
      },
      reserveCapacity: {
        execute: async (input) => {
          expect(input).toMatchObject({
            tenantId,
            programId,
            invoiceId,
            idempotencyKey: reserveKey,
          });
          expect(input.invoiceAmount).toEqual({ minor: 100000n, currency: 'USD' });
          return succeeded(201, reserveView);
        },
      } as Parameters<typeof createGrpcServer>[0]['reserveCapacity'],
      releaseReservation: {
        execute: async (input) => {
          expect(input).toMatchObject({
            tenantId,
            programId,
            reservationId,
            releaseRef,
            idempotencyKey: releaseKey,
            reason: 'CANCELLED',
          });
          expect(input.amount).toBeUndefined();
          return succeeded(201, releaseView);
        },
      } as Parameters<typeof createGrpcServer>[0]['releaseReservation'],
      getCapacity: {} as never,
      registry: new Registry(),
      onError: () => undefined,
    });

    try {
      const pact = () => new Pact({ consumer, provider, dir, logLevel: 'error' });
      await pact()
        .addSynchronousInteraction('reserve capacity for an invoice')
        .usingPlugin(plugin)
        .withPluginContents(
          contract(
            'Reserve',
            reserveKey,
            {
              program_id: programId,
              invoice_id: invoiceId,
              amount: { value: '1000.00', currency_code: 'USD' },
            },
            {
              result: 'RESERVE_RESULT_CREATED',
              reservation: { reservation_id: `matching(type, '${reservationId}')` },
            },
          ),
          'application/grpc',
        )
        .startTransport('grpc', host)
        .executeTest(async ({ port }) => {
          const gateway = gatewayAt(port);
          try {
            const result = await gateway.reserve({
              tenantId,
              programId,
              invoiceId,
              key: reserveKey,
              amount: { minor: 100000n, currency: 'USD' },
            });
            expect(result).toEqual({ kind: 'created', reservationId });
          } finally {
            gateway.close();
          }
        });

      await pact()
        .addSynchronousInteraction('release the whole reservation after payment refusal')
        .usingPlugin(plugin)
        .withPluginContents(
          contract(
            'Release',
            releaseKey,
            {
              program_id: programId,
              reservation_id: reservationId,
              release_ref: releaseRef,
              reason: 'RELEASE_REASON_CANCELLED',
            },
            { release: { reservation_id: reservationId } },
          ),
          'application/grpc',
        )
        .startTransport('grpc', host)
        .executeTest(async ({ port }) => {
          const gateway = gatewayAt(port);
          try {
            const result = await gateway.release({
              tenantId,
              programId,
              reservationId,
              releaseRef,
              key: releaseKey,
            });
            expect(result).toEqual({ kind: 'released' });
          } finally {
            gateway.close();
          }
        });

      await new Verifier({
        provider,
        pactUrls: [join(dir, `${consumer}-${provider}.json`)],
        transports: [{ port: await server.listen(0), protocol: 'grpc', scheme: 'grpc' }],
        logLevel: 'error',
      }).verifyProvider();
    } finally {
      await server.drain(1000);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
