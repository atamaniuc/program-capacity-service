import { status } from '@grpc/grpc-js';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/app.js';
import {
  grpcCapacityClient,
  httpCapacityClient,
  type CapacityClient,
  type Money,
  type Outcome,
  type Transport,
} from '../support/capacity-client.js';

/** What each problem type is on the wire; written out here, independent of the production table. */
const WIRE = {
  'insufficient-capacity': { http: 422, grpc: status.FAILED_PRECONDITION },
  'reservation-conflict': { http: 409, grpc: status.ALREADY_EXISTS },
  'idempotency-key-mismatch': { http: 422, grpc: status.FAILED_PRECONDITION },
  'release-ref-mismatch': { http: 422, grpc: status.FAILED_PRECONDITION },
  'release-exceeds-remaining': { http: 422, grpc: status.FAILED_PRECONDITION },
  'not-found': { http: 404, grpc: status.NOT_FOUND },
  unauthorized: { http: 401, grpc: status.UNAUTHENTICATED },
  forbidden: { http: 403, grpc: status.PERMISSION_DENIED },
} as const;

type Problem = keyof typeof WIRE;

const TRANSPORTS: readonly Transport[] = ['http', 'grpc'];

const usd = (value: string): Money => ({ value, currency: 'USD' });
const eur = (value: string): Money => ({ value, currency: 'EUR' });
const minor = (money: Money): bigint => BigInt(money.value.replace('.', ''));

function ok<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${outcome.problem} (${String(outcome.code)})`);
  }
  return outcome.value;
}

function expectProblem(outcome: Outcome<unknown>, transport: Transport, problem: Problem): void {
  expect(outcome).toEqual({ ok: false, problem, code: WIRE[problem][transport] });
}

describe('GR-03 the acceptance cases over REST and gRPC', () => {
  let app: TestApp;
  const clients: Record<Transport, CapacityClient> = {} as Record<Transport, CapacityClient>;

  beforeAll(async () => {
    app = await startTestApp();
    clients.http = httpCapacityClient(app);
    clients.grpc = grpcCapacityClient(app);
    await sql`INSERT INTO fx_rate (base, quote, rate, source, as_of)
              VALUES ('EUR', 'USD', 1.10, 'treasury', now())`.execute(app.persistence.db);
  });

  afterAll(async () => {
    for (const client of Object.values(clients)) client.close();
    await app.stop();
  });

  const seed = async (
    tenantId: string,
    programId: string,
    limitMinor: bigint,
    reservedMinor = 0n,
  ): Promise<void> => {
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor, reserved_minor)
              VALUES (${tenantId}, ${programId}, 'USD', ${limitMinor.toString()}::bigint,
                      ${reservedMinor.toString()}::bigint)`.execute(app.persistence.db);
  };

  const countRows = async (table: 'reservation' | 'ledger_entry', programId: string) => {
    const rows =
      table === 'reservation'
        ? await sql<{ n: string }>`SELECT count(*) AS n FROM reservation
            WHERE program_id = ${programId}`.execute(app.persistence.db)
        : await sql<{ n: string }>`SELECT count(*) AS n FROM ledger_entry
            WHERE program_id = ${programId}`.execute(app.persistence.db);
    return Number(rows.rows[0]?.n);
  };

  for (const transport of TRANSPORTS) {
    const client = (): CapacityClient => clients[transport];
    const program = (name: string): string => `${name}-${transport}`;

    it(`AC-01 (${transport}) lets exactly 10 of 50 concurrent reservations of 100,000 through`, async () => {
      const programId = program('ac01');
      await seed('bank-a', programId, 1_000_000_000n, 900_000_000n);
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          client().reserve({
            programId,
            invoiceId: `INV-AC01-${String(i)}`,
            amount: usd('100000.00'),
            key: `ac01-${transport}-${String(i)}`,
          }),
        ),
      );
      const succeeded = results.filter((r) => r.ok);
      const rejected = results.filter((r) => !r.ok);
      expect(succeeded).toHaveLength(10);
      expect(rejected).toHaveLength(40);
      for (const r of rejected) expectProblem(r, transport, 'insufficient-capacity');
      for (const r of succeeded) {
        if (r.ok) expect(r.value.reservation.reservedAmount).toEqual(usd('100000.00'));
      }
      const capacity = ok(await client().getCapacity({ programId }));
      expect(capacity).toMatchObject({
        reserved: '10000000.00',
        available: '0.00',
        limit: '10000000.00',
      });
      expect(await countRows('reservation', programId)).toBe(10);
    });

    it(`AC-02 (${transport}) returns the stored 201 for the same body and key, concurrent or not, with one ledger entry`, async () => {
      const programId = program('ac02');
      await seed('bank-a', programId, 1_000_000_000n);
      const request = {
        programId,
        invoiceId: 'INV-AC02',
        amount: usd('250.00'),
        key: `ac02-${transport}`,
      };
      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () => client().reserve(request)),
      );
      const later = await client().reserve(request);
      const all = [...concurrent, later].map((r) => ok(r));
      expect(new Set(all.map((r) => r.reservation.reservationId)).size).toBe(1);
      for (const r of all) expect(r.created).toBe(true);
      expect(all[0]?.snapshot).toEqual(all[5]?.snapshot);
      expect(await countRows('ledger_entry', programId)).toBe(1);
      expect(await countRows('reservation', programId)).toBe(1);
    });

    it(`AC-03 (${transport}) refuses a different body under the same key and changes nothing`, async () => {
      const programId = program('ac03');
      await seed('bank-a', programId, 1_000_000_000n);
      const first = ok(
        await client().reserve({
          programId,
          invoiceId: 'INV-AC03',
          amount: usd('100.00'),
          key: `ac03-${transport}`,
        }),
      );
      const other = await client().reserve({
        programId,
        invoiceId: 'INV-AC03',
        amount: usd('200.00'),
        key: `ac03-${transport}`,
      });
      expectProblem(other, transport, 'idempotency-key-mismatch');
      const capacity = ok(await client().getCapacity({ programId }));
      expect(capacity.reserved).toBe('100.00');
      expect(capacity.version).toBe(first.snapshot.version);
      expect(await countRows('reservation', programId)).toBe(1);
      expect(await countRows('ledger_entry', programId)).toBe(1);
    });

    it(`AC-04 (${transport}) answers an existing reservation for the same amount and a conflict for another`, async () => {
      const programId = program('ac04');
      await seed('bank-a', programId, 100_000_000_000n);
      const first = ok(
        await client().reserve({
          programId,
          invoiceId: 'INV-1',
          amount: eur('1000000.00'),
        }),
      );
      expect(first.created).toBe(true);
      expect(first.reservation.reservedAmount).toEqual(usd('1100000.00'));
      const same = ok(
        await client().reserve({
          programId,
          invoiceId: 'INV-1',
          amount: eur('1000000.00'),
        }),
      );
      expect(same.created).toBe(false);
      expect(same.reservation.reservationId).toBe(first.reservation.reservationId);
      expect(same.reservation.invoiceAmount).toEqual(eur('1000000.00'));
      const different = await client().reserve({
        programId,
        invoiceId: 'INV-1',
        amount: eur('999999.99'),
      });
      expectProblem(different, transport, 'reservation-conflict');
      expect(ok(await client().getCapacity({ programId })).reserved).toBe('1100000.00');
    });

    it(`AC-05 (${transport}) releases EUR 333,333.33 + 333,333.33 + 333,333.34 to exactly USD 1,100,000.00`, async () => {
      const programId = program('ac05');
      await seed('bank-a', programId, 100_000_000_000n);
      const reserved = ok(
        await client().reserve({
          programId,
          invoiceId: 'INV-AC05',
          amount: eur('1000000.00'),
        }),
      );
      expect(reserved.reservation.reservedAmount).toEqual(usd('1100000.00'));
      const reservationId = reserved.reservation.reservationId;
      const steps = [
        { amount: '333333.33', status: 'PARTIALLY_RELEASED' },
        { amount: '333333.33', status: 'PARTIALLY_RELEASED' },
        { amount: '333333.34', status: 'RELEASED' },
      ] as const;
      let freed = 0n;
      for (const [i, step] of steps.entries()) {
        const release = ok(
          await client().release({
            programId,
            reservationId,
            releaseRef: `ac05-${String(i)}`,
            reason: 'REPAID',
            amount: eur(step.amount),
          }),
        );
        expect(release.reservationStatus).toBe(step.status);
        expect(release.repaidAmount).toEqual(eur(step.amount));
        expect(release.releasedAmount.currency).toBe('USD');
        freed += minor(release.releasedAmount);
        expect(minor(release.remainingAmount)).toBe(110_000_000n - freed);
      }
      expect(freed).toBe(110_000_000n);
      expect(ok(await client().getCapacity({ programId })).reserved).toBe('0.00');
    });

    it(`AC-06 (${transport}) rejects a release above the remainder, replays the same one and refuses a changed one`, async () => {
      const programId = program('ac06');
      await seed('bank-a', programId, 100_000_000_000n);
      const { reservation } = ok(
        await client().reserve({ programId, invoiceId: 'INV-AC06', amount: eur('100.00') }),
      );
      const base = { programId, reservationId: reservation.reservationId };
      const x = {
        ...base,
        releaseRef: 'X',
        reason: 'REPAID',
        amount: eur('40.00'),
      } as const;
      const first = ok(await client().release(x));
      expect(first.releasedAmount).toEqual(usd('44.00'));
      expect(first.remainingAmount).toEqual(usd('66.00'));
      const before = ok(await client().getCapacity({ programId }));

      const above = await client().release({
        ...base,
        releaseRef: 'Y',
        reason: 'REPAID',
        amount: eur('60.01'),
      });
      expectProblem(above, transport, 'release-exceeds-remaining');
      expect(ok(await client().release(x))).toEqual(first);
      const changed = await client().release({ ...x, amount: eur('41.00') });
      expectProblem(changed, transport, 'release-ref-mismatch');

      expect(ok(await client().getCapacity({ programId }))).toEqual(before);
    });

    it(`AC-13 (${transport}) answers not-found across tenants, forbidden without the write scope, unauthorized without a token`, async () => {
      const programId = program('ac13');
      await seed('bank-b', programId, 1_000_000_000n);
      const readOnly = await app.token({ tenantId: 'bank-a', scope: 'capacity:read' });
      expectProblem(
        await client().getCapacity({ programId, token: readOnly }),
        transport,
        'not-found',
      );
      expectProblem(
        await client().reserve({
          programId,
          invoiceId: 'INV-AC13',
          amount: usd('1.00'),
          token: readOnly,
        }),
        transport,
        'forbidden',
      );
      expectProblem(
        await client().getCapacity({ programId, token: null }),
        transport,
        'unauthorized',
      );
      expect(await countRows('reservation', programId)).toBe(0);
    });

    it(`AC-16 (${transport}) changes only the calling tenant's program when two tenants share an id`, async () => {
      const programId = program('shared');
      await seed('bank-a', programId, 1_000_000_000n);
      await seed('bank-b', programId, 1_000_000_000n);
      const tokenB = await app.token({ tenantId: 'bank-b' });
      ok(await client().reserve({ programId, invoiceId: 'INV-AC16', amount: usd('500.00') }));
      const a = ok(await client().getCapacity({ programId }));
      const b = ok(await client().getCapacity({ programId, token: tokenB }));
      expect(a.reserved).toBe('500.00');
      expect(a.version).toBe(1);
      expect(b.reserved).toBe('0.00');
      expect(b.version).toBe(0);
    });

    it(`AC-17 (${transport}) replays a stored rejection under the same key, and a new key gets the freed capacity`, async () => {
      const programId = program('ac17');
      await seed('bank-a', programId, 100_000n);
      const held = ok(
        await client().reserve({ programId, invoiceId: 'INV-HELD', amount: usd('800.00') }),
      );
      const retry = {
        programId,
        invoiceId: 'INV-AC17',
        amount: usd('500.00'),
        key: `ac17-${transport}`,
      };
      expectProblem(await client().reserve(retry), transport, 'insufficient-capacity');

      ok(
        await client().release({
          programId,
          reservationId: held.reservation.reservationId,
          releaseRef: 'free-it',
          reason: 'CANCELLED',
        }),
      );
      expect(ok(await client().getCapacity({ programId })).available).toBe('1000.00');

      expectProblem(await client().reserve(retry), transport, 'insufficient-capacity');
      const fresh = ok(await client().reserve({ ...retry, key: `ac17-${transport}-new` }));
      expect(fresh.created).toBe(true);
      expect(fresh.reservation.reservedAmount).toEqual(usd('500.00'));
    });

    it(`FR-01 (${transport}) reads limit, reserved, available, overLimitBy, utilization, version and treasurySeq`, async () => {
      const fresh = program('fr01');
      await seed('bank-a', fresh, 1_000_000_000n);
      const cut = program('fr01-cut');
      await seed('bank-a', cut, 300_000_000n, 362_000_000n);
      expect(ok(await client().getCapacity({ programId: fresh }))).toEqual({
        programId: fresh,
        currency: 'USD',
        limit: '10000000.00',
        reserved: '0.00',
        available: '10000000.00',
        overLimitBy: '0.00',
        utilization: '0.0000',
        version: 0,
        treasurySeq: 0,
      });
      expect(ok(await client().getCapacity({ programId: cut }))).toMatchObject({
        available: '0.00',
        overLimitBy: '620000.00',
        utilization: '1.2066',
      });
      ok(
        await client().reserve({
          programId: fresh,
          invoiceId: 'INV-FR01',
          amount: eur('1000000.00'),
        }),
      );
      expect(ok(await client().getCapacity({ programId: fresh }))).toMatchObject({
        reserved: '1100000.00',
        available: '8900000.00',
        utilization: '0.1100',
        version: 1,
        treasurySeq: 0,
      });
      expectProblem(
        await client().getCapacity({ programId: program('fr01-missing') }),
        transport,
        'not-found',
      );
    });
  }

  it('AC-05 REST and gRPC agree on repaid and released amounts of an EUR invoice on a USD program', async () => {
    const releases = [];
    for (const transport of TRANSPORTS) {
      const programId = `cross-${transport}`;
      await seed('bank-a', programId, 100_000_000_000n);
      const client = clients[transport];
      const { reservation } = ok(
        await client.reserve({ programId, invoiceId: 'INV-CROSS', amount: eur('100.00') }),
      );
      const release = ok(
        await client.release({
          programId,
          reservationId: reservation.reservationId,
          releaseRef: 'cross-1',
          reason: 'REPAID',
          amount: eur('40.00'),
        }),
      );
      releases.push({ ...release, reservationId: '' });
    }
    const [http, grpc] = releases;
    expect(http?.repaidAmount).toEqual(eur('40.00'));
    expect(http?.releasedAmount).toEqual(usd('44.00'));
    expect(grpc).toEqual(http);
  });
});
