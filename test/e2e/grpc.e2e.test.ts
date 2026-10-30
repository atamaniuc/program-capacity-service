import { status } from '@grpc/grpc-js';
import { sql } from 'kysely';
import pg from 'pg';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BoundaryProblem } from '#src/capacity/adapters/in/boundary/problem.js';
import { JwtVerifier } from '#src/capacity/adapters/in/boundary/auth.js';
import {
  ReleaseReason,
  ReservationStatus,
  ReserveResult,
} from '#src/capacity/adapters/in/grpc/generated/finverity/capacity/v1/capacity_service.js';
import { createGrpcServer, METHOD_SCOPES } from '#src/capacity/adapters/in/grpc/server.js';
import type { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import { startTestApp, freePort, type TestApp } from '../support/app.js';
import { startTestIssuer, type TestIssuer } from '../support/auth.js';
import { grpcTestClient, type GrpcTestClient } from '../support/grpc-client.js';

interface RestCapacity {
  programId: string;
  currency: string;
  limit: string;
  reserved: string;
  available: string;
  overLimitBy: string;
  utilization: string;
  version: number;
  treasurySeq: number;
}

const usd = (value: string) => ({ value, currencyCode: 'USD' });

describe('gRPC adapter', () => {
  let app: TestApp;
  let client: GrpcTestClient;

  beforeAll(async () => {
    app = await startTestApp();
    client = grpcTestClient(app.grpcTarget);
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
              VALUES ('bank-a', 'grand-usd', 'USD', 100000000),
                     ('bank-a', 'small-usd', 'USD', 100000),
                     ('bank-b', 'b-only', 'USD', 100000000)`.execute(app.persistence.db);
  });

  afterAll(async () => {
    client.close();
    await app.stop();
  });

  const reserveRequest = (invoiceId: string, value = '1000.00', programId = 'grand-usd') => ({
    programId,
    invoiceId,
    amount: usd(value),
  });

  describe('GR-04 authentication and scopes', () => {
    it('GR-04 answers UNAUTHENTICATED without a token, before the message is validated', async () => {
      // An empty programId would be INVALID_ARGUMENT if the message were parsed first.
      const result = await client.reserve(reserveRequest('INV-A1', '1000.00', ''), {
        token: null,
        idempotencyKey: 'gr04-none',
      });
      expect(result).toMatchObject({ ok: false, code: status.UNAUTHENTICATED });
      if (!result.ok) {
        expect(result.info).toMatchObject({ reason: 'unauthorized', domain: 'capacity.finverity' });
        expect(result.statusCode).toBe(status.UNAUTHENTICATED);
      }
    });

    it('GR-04 answers UNAUTHENTICATED for a token signed by an unknown key and for an expired one', async () => {
      const unknownKey = await app.issuer.sign(
        { tenantId: 'bank-a', scope: 'capacity:write', sub: 'x' },
        { signWithOtherKey: true },
      );
      const expired = await app.issuer.sign({
        tenantId: 'bank-a',
        scope: 'capacity:write',
        sub: 'x',
        expiresIn: -120,
      });
      for (const token of [unknownKey, expired, 'not-a-jwt']) {
        const result = await client.getAvailability({ programId: 'grand-usd' }, { token });
        expect(result).toMatchObject({ ok: false, code: status.UNAUTHENTICATED });
      }
    });

    it('GR-04 answers PERMISSION_DENIED for a read-only token on Reserve and a write-only one on GetAvailability', async () => {
      const readOnly = await app.token({ scope: 'capacity:read' });
      const writeOnly = await app.token({ scope: 'capacity:write' });
      const reserve = await client.reserve(reserveRequest('INV-A2'), { token: readOnly });
      expect(reserve).toMatchObject({ ok: false, code: status.PERMISSION_DENIED });
      if (!reserve.ok) expect(reserve.info?.reason).toBe('forbidden');
      const read = await client.getAvailability({ programId: 'grand-usd' }, { token: writeOnly });
      expect(read).toMatchObject({ ok: false, code: status.PERMISSION_DENIED });
      const rows = await sql<{ n: string }>`SELECT count(*) AS n FROM reservation
        WHERE invoice_id = 'INV-A2'`.execute(app.persistence.db);
      expect(rows.rows[0]?.n).toBe('0');
    });

    describe('with a server of its own', () => {
      let issuer: TestIssuer;
      const unused = {} as never;

      beforeAll(async () => {
        issuer = await startTestIssuer();
      });
      afterAll(async () => {
        await issuer.close();
      });

      const serve = async (
        options: Partial<Parameters<typeof createGrpcServer>[0]>,
      ): Promise<{ target: string; stop: () => Promise<void> }> => {
        const server = createGrpcServer({
          verifier: new JwtVerifier({
            issuer: issuer.issuer,
            audience: issuer.audience,
            jwksUrl: issuer.jwksUrl,
          }),
          reserveCapacity: unused,
          releaseReservation: unused,
          getCapacity: unused,
          registry: new Registry(),
          onError: () => undefined,
          ...options,
        });
        const port = await server.listen(0);
        return { target: `127.0.0.1:${port}`, stop: () => server.drain(1000) };
      };

      it('GR-04 denies a method that is missing from the scope table, even with every scope', async () => {
        const server = await serve({
          scopes: {
            [Object.keys(METHOD_SCOPES)[0] ?? '']: 'capacity:write',
          },
        });
        const own = grpcTestClient(server.target);
        const token = await issuer.sign({
          tenantId: 'bank-a',
          scope: 'capacity:read capacity:write',
          sub: 'svc',
        });
        const result = await own.getAvailability({ programId: 'grand-usd' }, { token });
        expect(result).toMatchObject({ ok: false, code: status.PERMISSION_DENIED });
        own.close();
        await server.stop();
      });

      it('GR-04 answers UNAVAILABLE, not UNAUTHENTICATED, when the JWKS cannot be fetched', async () => {
        const server = await serve({
          verifier: new JwtVerifier({
            issuer: issuer.issuer,
            audience: issuer.audience,
            jwksUrl: `http://127.0.0.1:${await freePort()}/jwks`,
          }),
        });
        const own = grpcTestClient(server.target);
        const token = await issuer.sign({ tenantId: 'bank-a', scope: 'capacity:read', sub: 'svc' });
        const result = await own.getAvailability({ programId: 'grand-usd' }, { token });
        expect(result).toMatchObject({ ok: false, code: status.UNAVAILABLE });
        if (!result.ok) expect(result.info?.reason).toBe('service-unavailable');
        own.close();
        await server.stop();
      });

      it('GR-04 answers UNAUTHENTICATED for a late rejection before the message is validated or any use case runs', async () => {
        const execute = vi.fn();
        const server = await serve({
          verifier: {
            authenticate: async () => {
              await new Promise((resolve) => setTimeout(resolve, 200));
              throw new BoundaryProblem('unauthorized', 'The bearer token is invalid or expired.');
            },
          },
          reserveCapacity: { execute } as unknown as ReserveCapacity,
        });
        const own = grpcTestClient(server.target);
        // An empty programId would be INVALID_ARGUMENT, and a valid one would reach the use case.
        for (const programId of ['', 'grand-usd']) {
          const result = await own.reserve(reserveRequest('INV-EARLY', '10.00', programId), {
            token: 'ignored',
            idempotencyKey: 'gr04-early',
          });
          expect(result).toMatchObject({ ok: false, code: status.UNAUTHENTICATED });
          if (!result.ok) expect(result.info?.reason).toBe('unauthorized');
        }
        expect(execute).not.toHaveBeenCalled();
        own.close();
        await server.stop();
      });

      it('GR-05 does no work for a call whose deadline passed while it was authenticated', async () => {
        const execute = vi.fn();
        const server = await serve({
          verifier: {
            authenticate: async () => {
              await new Promise((resolve) => setTimeout(resolve, 400));
              return { tenantId: 'bank-a', actor: 'svc', scopes: new Set(['capacity:write']) };
            },
          },
          reserveCapacity: { execute } as unknown as ReserveCapacity,
          releaseReservation: unused,
          getCapacity: unused,
        });
        const own = grpcTestClient(server.target);
        const result = await own.reserve(reserveRequest('INV-LATE'), {
          token: 'ignored',
          deadlineMs: 150,
        });
        expect(result).toMatchObject({ ok: false, code: status.DEADLINE_EXCEEDED });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(execute).not.toHaveBeenCalled();
        own.close();
        await server.stop();
      });
    });
  });

  describe('GR-06 one set of rules for both transports', () => {
    it('GR-06 reserves with money as decimal strings and reads the REST capacity view back', async () => {
      const token = await app.token();
      const created = await client.reserve(reserveRequest('INV-B1', '1250.50'), {
        token,
        idempotencyKey: 'gr06-b1',
        requestId: 'req-gr06-b1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.result).toBe(ReserveResult.RESERVE_RESULT_CREATED);
      expect(created.value.reservation).toMatchObject({
        invoiceId: 'INV-B1',
        invoiceAmount: usd('1250.50'),
        reservedAmount: usd('1250.50'),
      });
      expect(created.value.capacity?.reserved?.value).toMatch(/^\d+\.\d{2}$/);

      const grpc = await client.getAvailability({ programId: 'grand-usd' }, { token });
      const rest = (await app.request('GET', '/v1/programs/grand-usd/capacity'))
        .body as RestCapacity;
      expect(grpc.ok).toBe(true);
      if (!grpc.ok) return;
      const view = grpc.value.capacity;
      expect(view).toMatchObject({
        programId: rest.programId,
        currencyCode: rest.currency,
        limit: usd(rest.limit),
        reserved: usd(rest.reserved),
        available: usd(rest.available),
        overLimitBy: usd(rest.overLimitBy),
        utilization: rest.utilization,
        version: rest.version,
        treasurySeq: rest.treasurySeq,
      });
      const ledger = await sql<{ actor: string; cause_id: string }>`SELECT actor, cause_id
        FROM ledger_entry
        WHERE reservation_id = ${created.value.reservation?.reservationId}::uuid`.execute(
        app.persistence.db,
      );
      expect(ledger.rows).toEqual([{ actor: 'svc-orders', cause_id: 'gr06-b1' }]);
    });

    it('GR-06 replays a reservation created over REST with key K, and rejects another body with K', async () => {
      const key = 'gr06-rest-first';
      const rest = await app.request('POST', '/v1/programs/grand-usd/reservations', {
        headers: { 'idempotency-key': key },
        body: { invoiceId: 'INV-B2', amount: { value: '500.00', currency: 'USD' } },
      });
      expect(rest.status).toBe(201);

      const token = await app.token();
      const replay = await client.reserve(reserveRequest('INV-B2', '500.00'), {
        token,
        idempotencyKey: key,
      });
      expect(replay.ok).toBe(true);
      if (replay.ok) {
        expect(replay.value.result).toBe(ReserveResult.RESERVE_RESULT_CREATED);
        expect(replay.value.reservation?.reservationId).toBe(
          (rest.body as { reservationId: string }).reservationId,
        );
      }
      const count = await sql<{ n: string }>`SELECT count(*) AS n FROM reservation
        WHERE invoice_id = 'INV-B2'`.execute(app.persistence.db);
      expect(count.rows[0]?.n).toBe('1');

      const other = await client.reserve(reserveRequest('INV-B2', '600.00'), {
        token,
        idempotencyKey: key,
      });
      expect(other).toMatchObject({ ok: false, code: status.FAILED_PRECONDITION });
      if (!other.ok) {
        expect(other.info).toMatchObject({
          reason: 'idempotency-key-mismatch',
          domain: 'capacity.finverity',
        });
        expect(other.info?.metadata['detail']).toBeTruthy();
      }
    });

    it('GR-06 answers EXISTING for a natural-key replay under another key', async () => {
      const token = await app.token();
      const first = await client.reserve(reserveRequest('INV-B3', '70.00'), {
        token,
        idempotencyKey: 'gr06-b3-first',
      });
      const second = await client.reserve(reserveRequest('INV-B3', '70.00'), {
        token,
        idempotencyKey: 'gr06-b3-second',
      });
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.value.result).toBe(ReserveResult.RESERVE_RESULT_EXISTING);
        expect(second.value.reservation?.reservationId).toBe(
          first.value.reservation?.reservationId,
        );
      }
    });

    it('GR-06 carries business rejections as FAILED_PRECONDITION with the REST problem type as reason', async () => {
      const token = await app.token();
      const result = await client.reserve(reserveRequest('INV-B4', '5000.00', 'small-usd'), {
        token,
        idempotencyKey: 'gr06-b4',
      });
      expect(result).toMatchObject({ ok: false, code: status.FAILED_PRECONDITION });
      if (!result.ok) expect(result.info?.reason).toBe('insufficient-capacity');
      // Another tenant's program is not found, not forbidden (AC-13).
      const crossTenant = await client.getAvailability({ programId: 'b-only' }, { token });
      expect(crossTenant).toMatchObject({ ok: false, code: status.NOT_FOUND });
      if (!crossTenant.ok) expect(crossTenant.info?.reason).toBe('not-found');
    });

    it('GR-06 answers INVALID_ARGUMENT for a bad amount and a bad key, and stores neither', async () => {
      const token = await app.token();
      const scale = await client.reserve(reserveRequest('INV-B5', '10.5'), { token });
      expect(scale).toMatchObject({ ok: false, code: status.INVALID_ARGUMENT });
      if (!scale.ok) expect(scale.info?.reason).toBe('validation-error');
      const key = await client.reserve(reserveRequest('INV-B5', '10.50'), {
        token,
        idempotencyKey: 'has a space',
      });
      expect(key).toMatchObject({ ok: false, code: status.INVALID_ARGUMENT });
    });

    it('GR-06 releases over gRPC and replays the release under the same key', async () => {
      const token = await app.token();
      const reserved = await client.reserve(reserveRequest('INV-B6', '300.00'), {
        token,
        idempotencyKey: 'gr06-b6',
      });
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      const reservationId = reserved.value.reservation?.reservationId ?? '';
      const release = {
        programId: 'grand-usd',
        reservationId,
        releaseRef: 'repay-b6',
        amount: usd('100.00'),
        reason: ReleaseReason.RELEASE_REASON_REPAID,
      };
      const first = await client.release(release, { token, idempotencyKey: 'gr06-b6-rel' });
      const again = await client.release(release, { token, idempotencyKey: 'gr06-b6-rel' });
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;
      expect(again.value).toEqual(first.value);
      expect(first.value.reservation).toBeUndefined();
      expect(first.value.release).toEqual({
        releaseRef: 'repay-b6',
        reservationId,
        reservationStatus: ReservationStatus.RESERVATION_STATUS_PARTIALLY_RELEASED,
        reason: ReleaseReason.RELEASE_REASON_REPAID,
        repaidAmount: usd('100.00'),
        releasedAmount: usd('100.00'),
        remainingAmount: usd('200.00'),
      });

      // A second, partial release; the REST replay of the same key is the reference view.
      const second = await client.release(
        { ...release, releaseRef: 'cancel-b6', reason: ReleaseReason.RELEASE_REASON_CANCELLED },
        { token, idempotencyKey: 'gr06-b6-rel2' },
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const rest = await app.request(
        'POST',
        `/v1/programs/grand-usd/reservations/${reservationId}/releases`,
        {
          headers: { 'idempotency-key': 'gr06-b6-rel2' },
          body: {
            releaseRef: 'cancel-b6',
            reason: 'CANCELLED',
            amount: { value: '100.00', currency: 'USD' },
          },
        },
      );
      const view = rest.body as {
        releaseRef: string;
        reservationStatus: string;
        invoiceAmount: { value: string };
        releasedAmount: { value: string };
        remainingAmount: { value: string };
      };
      expect(second.value.release).toEqual({
        releaseRef: view.releaseRef,
        reservationId,
        reservationStatus: ReservationStatus.RESERVATION_STATUS_PARTIALLY_RELEASED,
        reason: ReleaseReason.RELEASE_REASON_CANCELLED,
        repaidAmount: usd(view.invoiceAmount.value),
        releasedAmount: usd(view.releasedAmount.value),
        remainingAmount: usd(view.remainingAmount.value),
      });
      expect(view.remainingAmount.value).toBe('100.00');
      const unspecified = await client.release(
        { ...release, reason: 0, releaseRef: 'x' },
        { token },
      );
      expect(unspecified).toMatchObject({ ok: false, code: status.INVALID_ARGUMENT });
    });
  });

  describe('GR-05 deadlines', () => {
    it('GR-05 commits a Reserve after the client deadline expired, and the retry with the same key gets CREATED and the same id', async () => {
      const token = await app.token();
      const locker = new pg.Client({ connectionString: app.databaseUrl });
      await locker.connect();
      try {
        await locker.query("BEGIN; SELECT 1 FROM program WHERE id = 'grand-usd' FOR UPDATE");
        const expired = await client.reserve(reserveRequest('INV-D1', '40.00'), {
          token,
          idempotencyKey: 'gr05-d1',
          deadlineMs: 600,
        });
        expect(expired).toMatchObject({ ok: false, code: status.DEADLINE_EXCEEDED });
        await locker.query('COMMIT');
      } finally {
        await locker.end();
      }
      // The server did not abandon the transaction: it commits once the lock is free.
      const deadline = Date.now() + 10_000;
      let committed = 0;
      while (committed === 0 && Date.now() < deadline) {
        const rows = await sql<{ n: string }>`SELECT count(*) AS n FROM reservation
          WHERE invoice_id = 'INV-D1'`.execute(app.persistence.db);
        committed = Number(rows.rows[0]?.n);
        if (committed === 0) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(committed).toBe(1);

      const retry = await client.reserve(reserveRequest('INV-D1', '40.00'), {
        token,
        idempotencyKey: 'gr05-d1',
      });
      expect(retry.ok).toBe(true);
      const stored = await sql<{ id: string }>`SELECT id::text AS id FROM reservation
        WHERE invoice_id = 'INV-D1'`.execute(app.persistence.db);
      expect(stored.rows).toHaveLength(1);
      if (retry.ok) {
        expect(retry.value.result).toBe(ReserveResult.RESERVE_RESULT_CREATED);
        expect(retry.value.reservation?.reservationId).toBe(stored.rows[0]?.id);
      }
      const ledger = await sql<{ n: string }>`SELECT count(*) AS n FROM ledger_entry
        WHERE reservation_id = ${stored.rows[0]?.id}::uuid`.execute(app.persistence.db);
      expect(ledger.rows[0]?.n).toBe('1');
    });
  });

  describe('GR-04 telemetry and readiness', () => {
    it('GR-04 reports grpc in readiness and counts calls by method and code', async () => {
      const ready = await fetch(`${app.opsUrl}/health/ready`);
      expect(await ready.json()).toMatchObject({ status: 'up', grpc: 'up' });
      const token = await app.token();
      await client.getAvailability({ programId: 'grand-usd' }, { token });
      await client.getAvailability({ programId: 'nope' }, { token });
      const metrics = await (await fetch(`${app.opsUrl}/metrics`)).text();
      expect(metrics).toContain('grpc_server_requests_total{method="GetAvailability",code="OK"}');
      expect(metrics).toContain(
        'grpc_server_requests_total{method="GetAvailability",code="NOT_FOUND"}',
      );
      expect(metrics).toContain('grpc_server_duration_seconds_bucket');
    });
  });
});
