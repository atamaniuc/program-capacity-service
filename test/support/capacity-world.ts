import { sql } from 'kysely';
import { GetCapacity } from '#src/capacity/application/use-cases/queries/get-capacity/get-capacity.js';
import { GetReservation } from '#src/capacity/application/use-cases/queries/get-reservation/get-reservation.js';
import { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import { createPersistence, type Persistence } from '#src/capacity/adapters/out/postgres/db.js';
import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { PgCapacityReader } from '#src/capacity/adapters/out/postgres/repositories/capacity-reader.js';
import {
  PostgresUnitOfWork,
  type TransactionTimeouts,
} from '#src/capacity/adapters/out/postgres/unit-of-work.js';
import { systemClock, uuidV7Generator } from '#src/capacity/adapters/out/system/system.js';
import type { TransactionScope, UnitOfWork } from '#src/capacity/application/ports/index.js';
import { startPostgres, type TestPostgres } from './postgres.js';

export interface CapacityWorld {
  readonly postgres: TestPostgres;
  readonly persistence: Persistence;
  readonly uow: UnitOfWork;
  readonly reserve: ReserveCapacity;
  readonly release: ReleaseReservation;
  readonly getCapacity: GetCapacity;
  readonly getReservation: GetReservation;
  close(): Promise<void>;
}

export interface WorldOptions {
  readonly poolSize?: number;
  readonly fxMaxAgeMs?: number;
  readonly timeouts?: TransactionTimeouts;
  /** Wraps the unit of work, e.g. to hold a transaction open from a test. */
  readonly wrapUow?: (uow: UnitOfWork) => UnitOfWork;
}

export async function startCapacityWorld(options: WorldOptions = {}): Promise<CapacityWorld> {
  const postgres = await startPostgres();
  await migrate(postgres.url);
  const persistence = createPersistence(postgres.url, options.poolSize ?? 10);
  const base = new PostgresUnitOfWork(persistence, options.timeouts);
  const uow = options.wrapUow === undefined ? base : options.wrapUow(base);
  const reader = new PgCapacityReader(persistence.db);
  return {
    postgres,
    persistence,
    uow,
    reserve: new ReserveCapacity({
      uow,
      clock: systemClock,
      ids: uuidV7Generator,
      fxMaxAgeMs: options.fxMaxAgeMs ?? 24 * 3600 * 1000,
    }),
    release: new ReleaseReservation({ uow, clock: systemClock, ids: uuidV7Generator }),
    getCapacity: new GetCapacity(reader),
    getReservation: new GetReservation(reader),
    close: async () => {
      await persistence.close();
      await postgres.stop();
    },
  };
}

export interface SeedProgram {
  readonly tenantId: string;
  readonly id: string;
  readonly currency?: string;
  readonly limitMinor: bigint;
  readonly reservedMinor?: bigint;
  readonly status?: 'ACTIVE' | 'SUSPENDED';
}

export async function seedProgram(world: CapacityWorld, program: SeedProgram): Promise<void> {
  await sql`
    INSERT INTO program (tenant_id, id, currency, credit_limit_minor, reserved_minor, status)
    VALUES (${program.tenantId}, ${program.id}, ${program.currency ?? 'USD'},
            ${program.limitMinor.toString()}::bigint,
            ${(program.reservedMinor ?? 0n).toString()}::bigint,
            ${program.status ?? 'ACTIVE'})`.execute(world.persistence.db);
}

export async function seedFxRate(
  world: CapacityWorld,
  rate: { base: string; quote: string; rate: string; asOf?: Date; source?: string },
): Promise<void> {
  await sql`
    INSERT INTO fx_rate (base, quote, rate, source, as_of)
    VALUES (${rate.base}, ${rate.quote}, ${rate.rate}::numeric, ${rate.source ?? 'treasury'},
            ${rate.asOf ?? new Date()})`.execute(world.persistence.db);
}

export async function count(world: CapacityWorld, table: string, where = 'true'): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM ${sql.table(table)} WHERE ${sql.raw(where)}`.execute(
    world.persistence.db,
  );
  return Number(rows[0]?.n ?? '0');
}

export async function programRow(
  world: CapacityWorld,
  tenantId: string,
  id: string,
): Promise<{
  reserved_minor: string;
  credit_limit_minor: string;
  version: string;
  platform_seq: string;
}> {
  const { rows } = await sql<{
    reserved_minor: string;
    credit_limit_minor: string;
    version: string;
    platform_seq: string;
  }>`SELECT reserved_minor, credit_limit_minor, version, platform_seq FROM program
      WHERE tenant_id = ${tenantId} AND id = ${id}`.execute(world.persistence.db);
  const row = rows[0];
  if (row === undefined) throw new Error('program not found');
  return row;
}

/** Wraps a unit of work so a test can pause the first transaction right after `step` runs. */
export function holdFirstLedgerAppend(
  uow: UnitOfWork,
  gate: Promise<void>,
  onHeld: () => void,
): UnitOfWork {
  let held = false;
  return {
    run: (work) =>
      uow.run((tx: TransactionScope) =>
        work({
          ...tx,
          ledger: {
            append: async (entry) => {
              await tx.ledger.append(entry);
              if (!held) {
                held = true;
                onHeld();
                await gate;
              }
            },
          },
        }),
      ),
  };
}
