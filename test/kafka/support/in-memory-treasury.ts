import type {
  OwnReservation,
  ReconciliationDiffRow,
  SnapshotRow,
  TreasuryScope,
  TreasuryUnitOfWork,
} from '#src/capacity/application/ports/index.js';
import type { Program } from '#src/capacity/domain/index.js';
import { InMemoryWorld } from '../../support/in-memory-ports.js';

/** The unit-test stand-in for the treasury adapters, on top of the lane 0002 in-memory world. */
export class InMemoryTreasuryWorld extends InMemoryWorld implements TreasuryUnitOfWork {
  inbox = new Set<string>();
  fx: { base: string; quote: string; asOf: Date; source: string }[] = [];
  snapshots = new Map<string, SnapshotRow[]>();

  async runTreasury<T>(work: (tx: TreasuryScope) => Promise<T>): Promise<T> {
    const inboxBefore = new Set(this.inbox);
    const fxBefore = [...this.fx];
    const snapshotsBefore = new Map(
      [...this.snapshots].map(([k, rows]) => [k, rows.map((row) => ({ ...row }))]),
    );
    try {
      return await super.run((base) => work(this.extend(base)));
    } catch (error) {
      this.inbox = inboxBefore;
      this.fx = fxBefore;
      this.snapshots = snapshotsBefore;
      throw error;
    }
  }

  private extend(base: Parameters<Parameters<InMemoryWorld['run']>[0]>[0]): TreasuryScope {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const world = this;
    const key = (tenantId: string, id: string) => `${tenantId}/${id}`;
    const put = (program: Program): Program => {
      world.state.programs.set(key(program.tenantId, program.id), program);
      return program;
    };
    return {
      ...base,
      inbox: {
        claim: (source, messageId) => {
          const id = `${source.consumer}/${messageId}`;
          if (world.inbox.has(id)) return Promise.resolve(false);
          world.inbox.add(id);
          return Promise.resolve(true);
        },
        seen: (consumer, messageId) => Promise.resolve(world.inbox.has(`${consumer}/${messageId}`)),
      },
      treasuryPrograms: {
        find: (tenantId, programId) => world.getProgram(tenantId, programId),
        findAnyTenant: (programId) =>
          Promise.resolve(
            [...world.state.programs.values()].find((program) => program.id === programId) ?? null,
          ),
        createIfMissing: (program) => {
          if (!world.state.programs.has(key(program.tenantId, program.id))) {
            put({
              tenantId: program.tenantId,
              id: program.id,
              currency: program.currency,
              creditLimitMinor: 0n,
              reservedMinor: 0n,
              status: 'ACTIVE',
              version: 0,
              treasurySeq: 0,
              platformSeq: 0,
            });
          }
          return Promise.resolve();
        },
        applyChange: (tenantId, programId, change) => {
          const program = world.program(tenantId, programId);
          return Promise.resolve(
            put({
              ...program,
              creditLimitMinor: change.creditLimitMinor ?? program.creditLimitMinor,
              status: change.status ?? program.status,
              reservedMinor: program.reservedMinor + (change.reservedDeltaMinor ?? 0n),
              treasurySeq: Math.max(program.treasurySeq, change.treasurySeq),
              version: program.version + 1,
              platformSeq: program.platformSeq + 1,
            }),
          );
        },
        markTreasurySeq: (tenantId, programId, treasurySeq) => {
          const program = world.program(tenantId, programId);
          put({ ...program, treasurySeq: Math.max(program.treasurySeq, treasurySeq) });
          return Promise.resolve();
        },
      },
      treasuryReservations: {
        listForProgram: (tenantId, programId) =>
          Promise.resolve(
            [...world.state.reservations.values()]
              .filter((r) => r.tenantId === tenantId && r.programId === programId)
              .map((r): OwnReservation => ({
                id: r.id,
                invoiceId: r.invoiceId,
                invoiceCurrency: r.invoiceAmount.currency,
                invoiceAmountMinor: r.invoiceAmount.minor,
                releasedInvoiceMinor: r.releasedInvoiceMinor,
                amountMinor: r.amountMinor,
                releasedMinor: r.releasedMinor,
                status: r.status,
                platformSeq: r.platformSeq,
                createdAt: r.createdAt,
              })),
          ),
        loadSnapshot: (tenantId, programId, rows) => {
          world.snapshots.set(
            `${tenantId}/${programId}`,
            rows.map((row) => ({ ...row })),
          );
          return Promise.resolve();
        },
        diff: (tenantId, programId) => {
          const staged = world.snapshots.get(`${tenantId}/${programId}`) ?? [];
          const reservations = [...world.state.reservations.values()].filter(
            (r) => r.tenantId === tenantId && r.programId === programId,
          );
          const own = (r: (typeof reservations)[number]): OwnReservation => ({
            id: r.id,
            invoiceId: r.invoiceId,
            invoiceCurrency: r.invoiceAmount.currency,
            invoiceAmountMinor: r.invoiceAmount.minor,
            releasedInvoiceMinor: r.releasedInvoiceMinor,
            amountMinor: r.amountMinor,
            releasedMinor: r.releasedMinor,
            status: r.status,
            platformSeq: r.platformSeq,
            createdAt: r.createdAt,
          });
          const rows: ReconciliationDiffRow[] = [];
          for (const snapshot of staged) {
            const reservation = reservations.find((r) => r.invoiceId === snapshot.invoiceId);
            rows.push(
              reservation === undefined
                ? { side: 'snapshot-only', reservation: null, snapshot }
                : { side: 'both', reservation: own(reservation), snapshot },
            );
          }
          for (const reservation of reservations) {
            if (reservation.status === 'RELEASED') continue;
            if (!staged.some((snapshot) => snapshot.invoiceId === reservation.invoiceId)) {
              rows.push({ side: 'ours-only', reservation: own(reservation), snapshot: null });
            }
          }
          rows.sort((a, b) => {
            const left = a.snapshot?.invoiceId ?? a.reservation?.invoiceId ?? '';
            const right = b.snapshot?.invoiceId ?? b.reservation?.invoiceId ?? '';
            return a.side === b.side ? left.localeCompare(right) : a.side.localeCompare(b.side);
          });
          return Promise.resolve(rows);
        },
        overwrite: (_tenantId, _programId, rows) => {
          for (const row of rows) {
            const r = world.state.reservations.get(row.id);
            if (r === undefined) throw new Error('no such reservation');
            world.state.reservations.set(r.id, {
              ...r,
              invoiceAmount: { ...r.invoiceAmount, minor: row.invoiceAmountMinor },
              amountMinor: row.amountMinor,
              releasedInvoiceMinor: row.releasedInvoiceMinor,
              releasedMinor: row.releasedMinor,
              status: row.status,
            });
          }
          return Promise.resolve();
        },
        insertMany: (rows) => {
          for (const row of rows) world.state.reservations.set(row.id, row);
          return Promise.resolve();
        },
      },
      fxWriter: {
        upsert: (rate) => {
          const exists = world.fx.some(
            (r) => r.base === rate.base && r.quote === rate.quote && +r.asOf === +rate.asOf,
          );
          if (!exists) {
            world.fx.push({
              base: rate.base,
              quote: rate.quote,
              asOf: rate.asOf,
              source: rate.source,
            });
            world.addFx(rate.base, rate.quote, rate.rate.scaled, rate.asOf, rate.source);
          }
          return Promise.resolve(!exists);
        },
      },
      ledgerBatch: {
        appendMany: (entries) => {
          world.state.ledger.push(...entries);
          return Promise.resolve();
        },
      },
    };
  }

  override run<T>(work: (tx: TreasuryScope) => Promise<T>): Promise<T> {
    return this.runTreasury(work);
  }
}
