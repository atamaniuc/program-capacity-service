import type {
  CapacityReader,
  Clock,
  FxQuote,
  IdGenerator,
  OutboxEvent,
  ReleaseRecord,
  ReleaseSummary,
  StoredIdempotency,
  TransactionScope,
  UnitOfWork,
} from '#src/capacity/application/ports/index.js';
import type { Outcome } from '#src/capacity/application/shared/problem.js';
import type { LedgerEntry, Program, Reservation } from '#src/capacity/domain/index.js';

interface ReleaseRow extends ReleaseRecord {
  readonly reservationId: string;
  invoiceMinor: bigint | null;
  programMinor: bigint | null;
  createdAt: Date;
}

interface State {
  programs: Map<string, Program>;
  reservations: Map<string, Reservation>;
  releases: ReleaseRow[];
  ledger: LedgerEntry[];
  outbox: OutboxEvent[];
  idempotency: Map<string, StoredIdempotency>;
  fxRates: (FxQuote & { base: string; quote: string })[];
}

const programKey = (tenantId: string, id: string): string => `${tenantId}/${id}`;

function cloneState(state: State): State {
  return {
    programs: new Map(state.programs),
    reservations: new Map(state.reservations),
    releases: state.releases.map((row) => ({ ...row })),
    ledger: [...state.ledger],
    outbox: [...state.outbox],
    idempotency: new Map(state.idempotency),
    fxRates: [...state.fxRates],
  };
}

/** A sequential, rollback-capable stand-in for the PostgreSQL adapters (unit and property tests). */
export class InMemoryWorld implements UnitOfWork, CapacityReader {
  state: State = {
    programs: new Map(),
    reservations: new Map(),
    releases: [],
    ledger: [],
    outbox: [],
    idempotency: new Map(),
    fxRates: [],
  };
  private counter = 0;
  now = new Date('2026-10-28T10:00:00Z');

  readonly clock: Clock = { now: () => new Date(this.now) };
  readonly ids: IdGenerator = {
    next: () => `00000000-0000-7000-8000-${String(++this.counter).padStart(12, '0')}`,
  };

  addProgram(program: Program): void {
    this.state.programs.set(programKey(program.tenantId, program.id), program);
  }

  addFx(base: string, quote: string, rate: bigint, asOf: Date, source = 'treasury'): void {
    this.state.fxRates.push({ base, quote, rate: { scaled: rate }, source, asOf });
  }

  program(tenantId: string, id: string): Program {
    const program = this.state.programs.get(programKey(tenantId, id));
    if (program === undefined) throw new Error('no such program');
    return program;
  }

  async run<T>(work: (tx: TransactionScope) => Promise<T>): Promise<T> {
    const before = cloneState(this.state);
    try {
      return await work(this.scope());
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  getProgram(tenantId: string, programId: string): Promise<Program | null> {
    return Promise.resolve(this.state.programs.get(programKey(tenantId, programId)) ?? null);
  }

  getReservation(
    tenantId: string,
    programId: string,
    reservationId: string,
  ): Promise<{ reservation: Reservation; releases: readonly ReleaseSummary[] } | null> {
    const reservation = this.state.reservations.get(reservationId);
    if (reservation?.tenantId !== tenantId || reservation.programId !== programId) {
      return Promise.resolve(null);
    }
    const releases = this.state.releases
      .filter((row) => row.reservationId === reservationId && row.programMinor !== null)
      .map((row) => ({
        releaseRef: row.releaseRef,
        reason: row.reason,
        invoiceMinor: row.invoiceMinor ?? 0n,
        programMinor: row.programMinor ?? 0n,
        createdAt: row.createdAt,
      }));
    return Promise.resolve({ reservation, releases });
  }

  private scope(): TransactionScope {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const world = this;
    const setProgram = (program: Program): Program => {
      world.state.programs.set(programKey(program.tenantId, program.id), program);
      return program;
    };
    return {
      programs: {
        lockForUpdate: (tenantId, id) => world.getProgram(tenantId, id),
        reserve: (tenantId, id, amount) => {
          const program = world.state.programs.get(programKey(tenantId, id));
          if (program === undefined || program.creditLimitMinor - program.reservedMinor < amount) {
            return Promise.resolve(null);
          }
          return Promise.resolve(
            setProgram({
              ...program,
              reservedMinor: program.reservedMinor + amount,
              version: program.version + 1,
              platformSeq: program.platformSeq + 1,
            }),
          );
        },
        release: (tenantId, id, amount) => {
          const program = world.state.programs.get(programKey(tenantId, id));
          if (program === undefined || program.reservedMinor < amount) return Promise.resolve(null);
          return Promise.resolve(
            setProgram({
              ...program,
              reservedMinor: program.reservedMinor - amount,
              version: program.version + 1,
              platformSeq: program.platformSeq + 1,
            }),
          );
        },
      },
      reservations: {
        findByInvoice: (tenantId, programId, invoiceId) =>
          Promise.resolve(
            [...world.state.reservations.values()].find(
              (r) =>
                r.tenantId === tenantId && r.programId === programId && r.invoiceId === invoiceId,
            ) ?? null,
          ),
        invoiceCurrencyOf: (tenantId, programId, reservationId) => {
          const r = world.state.reservations.get(reservationId);
          return Promise.resolve(
            r?.tenantId === tenantId && r.programId === programId ? r.invoiceAmount.currency : null,
          );
        },
        lockById: (tenantId, programId, reservationId) => {
          const r = world.state.reservations.get(reservationId);
          return Promise.resolve(r?.tenantId === tenantId && r.programId === programId ? r : null);
        },
        insert: (reservation) => {
          world.state.reservations.set(reservation.id, reservation);
          return Promise.resolve();
        },
        applyRelease: (change) => {
          const r = world.state.reservations.get(change.id);
          if (r === undefined) throw new Error('no such reservation');
          world.state.reservations.set(r.id, { ...r, ...change });
          return Promise.resolve();
        },
      },
      releases: {
        claim: (claim) => {
          const taken = world.state.releases.some(
            (row) =>
              row.reservationId === claim.reservationId && row.releaseRef === claim.releaseRef,
          );
          if (taken) return Promise.resolve(false);
          world.state.releases.push({
            id: claim.id,
            reservationId: claim.reservationId,
            releaseRef: claim.releaseRef,
            fingerprint: claim.fingerprint,
            reason: claim.reason,
            result: null,
            invoiceMinor: null,
            programMinor: null,
            createdAt: world.clock.now(),
          });
          return Promise.resolve(true);
        },
        find: (reservationId, releaseRef) =>
          Promise.resolve(
            world.state.releases.find(
              (row) => row.reservationId === reservationId && row.releaseRef === releaseRef,
            ) ?? null,
          ),
        complete: (id, amounts, result: Outcome<unknown>) => {
          const row = world.state.releases.find((r) => r.id === id);
          if (row === undefined) throw new Error('no such release claim');
          row.invoiceMinor = amounts.invoiceMinor;
          row.programMinor = amounts.programMinor;
          (row as { result: Outcome<unknown> | null }).result = result;
          return Promise.resolve();
        },
        discard: (id) => {
          world.state.releases = world.state.releases.filter((row) => row.id !== id);
          return Promise.resolve();
        },
      },
      ledger: {
        append: (entry) => {
          world.state.ledger.push(entry);
          return Promise.resolve();
        },
      },
      outbox: {
        append: (event) => {
          world.state.outbox.push(event);
          return Promise.resolve();
        },
      },
      fxRates: {
        latest: (base, quote, notBefore) => {
          const fresh = world.state.fxRates
            .filter((r) => r.base === base && r.quote === quote && r.asOf > notBefore)
            .sort((a, b) => b.asOf.getTime() - a.asOf.getTime());
          return Promise.resolve(fresh[0] ?? null);
        },
      },
      idempotency: {
        claim: (tenantId, key, fingerprint) => {
          const id = `${tenantId}/${key}`;
          if (world.state.idempotency.has(id)) return Promise.resolve(false);
          world.state.idempotency.set(id, { fingerprint, outcome: null });
          return Promise.resolve(true);
        },
        find: (tenantId, key) =>
          Promise.resolve(world.state.idempotency.get(`${tenantId}/${key}`) ?? null),
        complete: (tenantId, key, _status, outcome) => {
          const id = `${tenantId}/${key}`;
          const row = world.state.idempotency.get(id);
          if (row === undefined) throw new Error('no such key');
          world.state.idempotency.set(id, { fingerprint: row.fingerprint, outcome });
          return Promise.resolve();
        },
      },
    };
  }
}
