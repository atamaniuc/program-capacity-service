import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresTreasuryUnitOfWork } from '#src/capacity/adapters/out/postgres/treasury-unit-of-work.js';
import { systemClock, uuidV7Generator } from '#src/capacity/adapters/out/system/system.js';
import { PermanentError } from '#src/capacity/application/shared/treasury-errors.js';
import {
  programReconciledSchema,
  type ProgramReconciled,
} from '#src/capacity/application/shared/treasury-messages.js';
import {
  ReconcileProgram,
  type ReconcileProgramDeps,
} from '#src/capacity/application/use-cases/reconcile-program/reconcile-program.js';
import { snapshot, type Amount } from '../../tools/simulator/messages.js';
import {
  count,
  programRow,
  seedFxRate,
  seedProgram,
  startCapacityWorld,
  type CapacityWorld,
} from '../support/capacity-world.js';

const TENANT = 'bank-a';
const SOURCE = { consumer: 'treasury-capacity', topic: 'treasury.capacity.v1', partition: 0 };
const usd = (value: string): Amount => ({ value, currency: 'USD' });
const eur = (value: string): Amount => ({ value, currency: 'EUR' });

interface Logged {
  level: 'info' | 'warn';
  fields: Record<string, unknown>;
}

describe('reconciliation', () => {
  let world: CapacityWorld;
  let logs: Logged[];
  let offset = 0n;
  let programCounter = 0;
  let invoiceCounter = 0;

  function reconciler(
    overrides: Partial<ReconcileProgramDeps> = {},
    mode: 'HOLD' | 'RELEASE' = 'HOLD',
  ): ReconcileProgram {
    return new ReconcileProgram({
      uow: new PostgresTreasuryUnitOfWork(world.persistence),
      clock: systemClock,
      ids: uuidV7Generator,
      logger: {
        info: (fields) => logs.push({ level: 'info', fields }),
        warn: (fields) => logs.push({ level: 'warn', fields }),
      },
      policy: { toleranceMinor: 1n, mode, skewMs: 5 * 60 * 1000 },
      maxReservations: 50_000,
      ...overrides,
    });
  }

  function message(
    programId: string,
    seq: number,
    payload: Parameters<typeof snapshot>[1],
    messageId?: string,
  ): ProgramReconciled {
    const produced = snapshot(
      { tenantId: TENANT, programId, seq, ...(messageId === undefined ? {} : { messageId }) },
      payload,
    );
    return programReconciledSchema.parse(JSON.parse(produced.value));
  }

  function apply(reconcile: ReconcileProgram, programMessage: ProgramReconciled) {
    return reconcile.execute({ ...SOURCE, offset: ++offset }, programMessage);
  }

  async function newProgram(limit = 1_000_000_000n): Promise<string> {
    const id = `prg-${++programCounter}`;
    await seedProgram(world, { tenantId: TENANT, id, limitMinor: limit });
    return id;
  }

  async function reserve(programId: string, minor: bigint, currency = 'USD'): Promise<string> {
    const outcome = await world.reserve.execute({
      tenantId: TENANT,
      actor: 'svc-orders',
      requestId: 'req',
      programId,
      invoiceId: `INV-${++invoiceCounter}`,
      invoiceAmount: { minor, currency },
    });
    if (!outcome.ok) throw new Error(`setup reserve failed: ${outcome.problem.type}`);
    return outcome.value.reservationId;
  }

  async function invoiceOf(reservationId: string): Promise<string> {
    const { rows } = await sql<{ invoice_id: string }>`
      SELECT invoice_id FROM reservation WHERE id = ${reservationId}::uuid`.execute(
      world.persistence.db,
    );
    return rows[0]?.invoice_id ?? '';
  }

  async function reservationOf(programId: string, invoiceId: string) {
    const { rows } = await sql<{
      status: string;
      origin: string;
      amount_minor: string;
      released_minor: string;
      invoice_amount_minor: string;
      released_invoice_minor: string;
    }>`SELECT status, origin, amount_minor, released_minor, invoice_amount_minor, released_invoice_minor
         FROM reservation WHERE program_id = ${programId} AND invoice_id = ${invoiceId}`.execute(
      world.persistence.db,
    );
    return rows[0];
  }

  /** I1: reserved = Σ (amount − released) over the reservations that are not RELEASED. */
  async function expectI1(programId: string): Promise<void> {
    const { rows } = await sql<{ open: string }>`
      SELECT COALESCE(SUM(amount_minor - released_minor), 0)::text AS open
        FROM reservation WHERE program_id = ${programId} AND status <> 'RELEASED'`.execute(
      world.persistence.db,
    );
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe(rows[0]?.open);
  }

  const ledgerKinds = async (programId: string) => {
    const { rows } = await sql<{ kind: string }>`
      SELECT kind FROM ledger_entry WHERE program_id = ${programId} ORDER BY id`.execute(
      world.persistence.db,
    );
    return rows.map((row) => row.kind);
  };

  beforeAll(async () => {
    world = await startCapacityWorld();
    await seedFxRate(world, { base: 'EUR', quote: 'USD', rate: '1.1' });
  });

  beforeEach(() => {
    logs = [];
  });

  afterAll(async () => {
    await world.close();
  });

  it('AC-08 keeps an in-flight reservation the snapshot omits, because its platform event is above the watermark', async () => {
    const programId = await newProgram();
    const inv1 = await invoiceOf(await reserve(programId, 100_000_00n));
    const inv2 = await invoiceOf(await reserve(programId, 250_000_00n));
    const inv3 = await invoiceOf(await reserve(programId, 50_000_00n));
    await sql`UPDATE program SET platform_seq = 57 WHERE id = ${programId}`.execute(
      world.persistence.db,
    );
    const inv4 = await invoiceOf(await reserve(programId, 31_000_00n));
    expect((await programRow(world, TENANT, programId)).platform_seq).toBe('58');

    const result = await apply(
      reconciler(),
      message(programId, 41, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 57,
        reservations: [
          {
            invoiceId: inv1,
            outstandingInvoiceAmount: usd('100000.00'),
            outstandingReservedAmount: usd('100000.00'),
          },
          {
            invoiceId: inv2,
            outstandingInvoiceAmount: usd('250000.00'),
            outstandingReservedAmount: usd('250000.00'),
          },
          {
            invoiceId: inv3,
            outstandingInvoiceAmount: usd('50000.00'),
            outstandingReservedAmount: usd('50000.00'),
          },
        ],
      }),
    );

    expect(result.status).toBe('applied');
    expect((await reservationOf(programId, inv4))?.status).toBe('ACTIVE');
    // reserved = snapshot total (400,000.00) + INV-4 (31,000.00)
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe('43100000');
    expect(await ledgerKinds(programId)).not.toContain('RECON_ADJUST');
    expect(
      await count(
        world,
        'outbox_event',
        `program_id = '${programId}' AND type = 'ReconciliationDriftDetected'`,
      ),
    ).toBe(0);
    await expectI1(programId);
  });

  it('AC-08 HOLD keeps a reservation the snapshot omits although treasury has seen it, and raises a drift event', async () => {
    const programId = await newProgram();
    const kept = await invoiceOf(await reserve(programId, 80_000_00n));
    await reserve(programId, 20_000_00n);

    const result = await apply(
      reconciler(),
      message(programId, 5, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 2,
        reservations: [],
      }),
    );

    expect(result.status).toBe('applied');
    expect((await reservationOf(programId, kept))?.status).toBe('ACTIVE');
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe('10000000');
    const { rows } = await sql<{ payload: { drifts: { kind: string }[] } }>`
      SELECT payload FROM outbox_event
       WHERE program_id = ${programId} AND type = 'ReconciliationDriftDetected'`.execute(
      world.persistence.db,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.drifts.map((drift) => drift.kind)).toEqual(['HELD', 'HELD']);
    expect(logs.some((log) => log.fields['kind'] === 'HELD')).toBe(true);
    await expectI1(programId);
  });

  it('AC-08 RELEASE mode releases a reservation the snapshot omits although treasury has seen it', async () => {
    const programId = await newProgram();
    const dropped = await invoiceOf(await reserve(programId, 80_000_00n));
    const stays = await invoiceOf(await reserve(programId, 20_000_00n));

    await apply(
      reconciler({}, 'RELEASE'),
      message(programId, 5, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 2,
        reservations: [
          {
            invoiceId: stays,
            outstandingInvoiceAmount: usd('20000.00'),
            outstandingReservedAmount: usd('20000.00'),
          },
        ],
      }),
    );

    expect((await reservationOf(programId, dropped))?.status).toBe('RELEASED');
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe('2000000');
    expect(await ledgerKinds(programId)).toContain('RECON_ADJUST');
    await expectI1(programId);
  });

  it('AC-08 without a watermark compares asOf with creation time and logs reconciliation_fallback', async () => {
    const programId = await newProgram();
    const fresh = await invoiceOf(await reserve(programId, 10_000_00n));

    await apply(
      reconciler(),
      message(programId, 3, {
        asOf: new Date(Date.now() - 3_600_000),
        creditLimit: usd('10000000.00'),
        reservations: [],
      }),
    );
    expect((await reservationOf(programId, fresh))?.status).toBe('ACTIVE');
    expect(logs.filter((log) => log.fields['event'] === 'reconciliation_fallback')).toHaveLength(1);
    // Created after asOf: treasury cannot have seen it, so no drift is raised.
    expect(
      await count(
        world,
        'outbox_event',
        `program_id = '${programId}' AND type = 'ReconciliationDriftDetected'`,
      ),
    ).toBe(0);

    await apply(
      reconciler(),
      message(programId, 4, {
        asOf: new Date(Date.now() + 3_600_000),
        creditLimit: usd('10000000.00'),
        reservations: [],
      }),
    );
    // Older than asOf minus the skew margin: treasury should know it, so HOLD raises a drift event.
    expect(
      await count(
        world,
        'outbox_event',
        `program_id = '${programId}' AND type = 'ReconciliationDriftDetected'`,
      ),
    ).toBe(1);
    expect(logs.filter((log) => log.fields['event'] === 'reconciliation_fallback')).toHaveLength(2);
  });

  it('AC-14 leaves a reservation one minor unit away alone and logs a within-tolerance line', async () => {
    const programId = await newProgram();
    const invoice = await invoiceOf(await reserve(programId, 1_000_00n, 'EUR'));
    expect((await reservationOf(programId, invoice))?.amount_minor).toBe('110000');
    const ledgerBefore = await ledgerKinds(programId);

    const result = await apply(
      reconciler(),
      message(programId, 7, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 1,
        reservations: [
          {
            invoiceId: invoice,
            outstandingInvoiceAmount: eur('1000.00'),
            outstandingReservedAmount: usd('1100.01'),
          },
        ],
      }),
    );

    expect(result.status).toBe('applied');
    expect(await ledgerKinds(programId)).toEqual(ledgerBefore);
    expect((await reservationOf(programId, invoice))?.amount_minor).toBe('110000');
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe('110000');
    const line = logs.find((log) => log.fields['event'] === 'within-tolerance');
    expect(line?.fields).toMatchObject({ invoiceId: invoice, programDiffMinor: '1' });
    expect(
      await count(
        world,
        'outbox_event',
        `program_id = '${programId}' AND type = 'ReconciliationDriftDetected'`,
      ),
    ).toBe(0);
    await expectI1(programId);
  });

  it('AC-15 lets treasury win on a different outstanding invoice amount', async () => {
    const programId = await newProgram();
    const invoice = await invoiceOf(await reserve(programId, 1_000_00n, 'EUR'));

    await apply(
      reconciler(),
      message(programId, 8, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 1,
        reservations: [
          {
            invoiceId: invoice,
            outstandingInvoiceAmount: eur('900.00'),
            outstandingReservedAmount: usd('990.00'),
          },
        ],
      }),
    );

    const row = await reservationOf(programId, invoice);
    expect(row).toMatchObject({
      status: 'PARTIALLY_RELEASED',
      released_invoice_minor: '10000',
      released_minor: '11000',
    });
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe('99000');
    expect(await ledgerKinds(programId)).toEqual(['RESERVE', 'RECON_ADJUST']);
    const { rows } = await sql<{ delta_reserved_minor: string; reserved_after: string }>`
      SELECT delta_reserved_minor, reserved_after FROM ledger_entry
       WHERE program_id = ${programId} AND kind = 'RECON_ADJUST'`.execute(world.persistence.db);
    expect(rows[0]).toEqual({ delta_reserved_minor: '-11000', reserved_after: '99000' });
    expect(
      await count(
        world,
        'outbox_event',
        `program_id = '${programId}' AND type = 'ReconciliationDriftDetected'`,
      ),
    ).toBe(1);
    expect(
      await count(
        world,
        'outbox_event',
        `program_id = '${programId}' AND type = 'ProgramCapacityChanged'`,
      ),
    ).toBe(1);
    await expectI1(programId);
  });

  it('AC-15 lets treasury win on a program amount beyond tolerance', async () => {
    const programId = await newProgram();
    const invoice = await invoiceOf(await reserve(programId, 1_000_00n, 'EUR'));

    await apply(
      reconciler(),
      message(programId, 9, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 1,
        reservations: [
          {
            invoiceId: invoice,
            outstandingInvoiceAmount: eur('1000.00'),
            outstandingReservedAmount: usd('1100.05'),
          },
        ],
      }),
    );

    expect((await reservationOf(programId, invoice))?.amount_minor).toBe('110005');
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe('110005');
    expect(await ledgerKinds(programId)).toEqual(['RESERVE', 'RECON_ADJUST']);
    await expectI1(programId);
  });

  it('AC-15 adopts a reservation only treasury knows with origin TREASURY, and applies the limit', async () => {
    const programId = await newProgram(500_000_00n);

    await apply(
      reconciler(),
      message(programId, 10, {
        asOf: new Date(),
        creditLimit: usd('8000000.00'),
        platformWatermark: 0,
        reservations: [
          {
            invoiceId: 'INV-TREASURY',
            outstandingInvoiceAmount: eur('1000.00'),
            outstandingReservedAmount: usd('1100.00'),
          },
        ],
      }),
    );

    const row = await reservationOf(programId, 'INV-TREASURY');
    expect(row).toMatchObject({ origin: 'TREASURY', status: 'ACTIVE', amount_minor: '110000' });
    const state = await programRow(world, TENANT, programId);
    expect(state.reserved_minor).toBe('110000');
    expect(state.credit_limit_minor).toBe('800000000');
    expect(await ledgerKinds(programId)).toEqual(['LIMIT_SET', 'RECON_ADJUST']);
    await expectI1(programId);
  });

  it('AC-09 skips a snapshot whose seq is at or below the program seq', async () => {
    const programId = await newProgram();
    const reconcile = reconciler();
    await apply(
      reconcile,
      message(programId, 20, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 0,
        reservations: [],
      }),
    );
    const before = await programRow(world, TENANT, programId);

    const stale = await apply(
      reconcile,
      message(
        programId,
        20,
        {
          asOf: new Date(),
          creditLimit: usd('1.00'),
          platformWatermark: 0,
          reservations: [],
        },
        'AC-09-stale-snapshot',
      ),
    );

    expect(stale).toEqual({ status: 'stale', treasurySeq: 20 });
    expect(await programRow(world, TENANT, programId)).toEqual(before);
  });

  it('AC-08 recomputes the diff when the program moves between planning and the lock', async () => {
    const programId = await newProgram();
    const known = await invoiceOf(await reserve(programId, 10_000_00n));
    let late = '';
    const reconcile = reconciler({
      betweenPlanAndLock: async () => {
        late = await invoiceOf(await reserve(programId, 5_000_00n));
      },
    });

    const result = await apply(
      reconcile,
      message(programId, 30, {
        asOf: new Date(),
        creditLimit: usd('10000000.00'),
        platformWatermark: 1,
        reservations: [
          {
            invoiceId: known,
            outstandingInvoiceAmount: usd('10000.00'),
            outstandingReservedAmount: usd('10000.00'),
          },
        ],
      }),
    );

    expect(result.status === 'applied' && result.recomputed).toBe(true);
    // The reservation made after planning has platform_seq 2 > watermark 1, so it is kept.
    expect((await reservationOf(programId, late))?.status).toBe('ACTIVE');
    expect((await programRow(world, TENANT, programId)).reserved_minor).toBe('1500000');
    await expectI1(programId);
  });

  it('AC-15 refuses a snapshot above RECON_MAX_RESERVATIONS so it can go to the DLQ', async () => {
    const programId = await newProgram();
    const reservations = Array.from({ length: 3 }, (_, index) => ({
      invoiceId: `BIG-${index}`,
      outstandingInvoiceAmount: usd('1.00'),
      outstandingReservedAmount: usd('1.00'),
    }));
    await expect(
      apply(
        reconciler({ maxReservations: 2 }),
        message(programId, 40, {
          asOf: new Date(),
          creditLimit: usd('10000000.00'),
          platformWatermark: 0,
          reservations,
        }),
      ),
    ).rejects.toMatchObject({ code: 'snapshot-too-large' });
    await expect(
      apply(
        reconciler(),
        message('missing-program', 1, {
          asOf: new Date(),
          creditLimit: usd('1.00'),
          reservations: [],
        }),
      ),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('AC-10 treats a redelivered snapshot as a duplicate', async () => {
    const programId = await newProgram();
    const reconcile = reconciler();
    const snap = message(programId, 50, {
      asOf: new Date(),
      creditLimit: usd('9000000.00'),
      platformWatermark: 0,
      reservations: [],
    });
    expect((await apply(reconcile, snap)).status).toBe('applied');
    expect((await apply(reconcile, snap)).status).toBe('duplicate');
    expect(await ledgerKinds(programId)).toEqual(['LIMIT_SET']);
  });
});
