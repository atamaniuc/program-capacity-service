import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { Persistence } from '#src/capacity/adapters/out/postgres/db.js';
import { PgQueryReader } from '#src/capacity/adapters/out/postgres/repositories/query.repository.js';
import { PgCapacityReader } from '#src/capacity/adapters/out/postgres/repositories/capacity-reader.js';
import { PostgresUnitOfWork } from '#src/capacity/adapters/out/postgres/unit-of-work.js';
import { systemClock, uuidV7Generator } from '#src/capacity/adapters/out/system/system.js';
import { GetCapacity } from '#src/capacity/application/use-cases/queries/get-capacity/get-capacity.js';
import { GetLedger } from '#src/capacity/application/use-cases/queries/get-ledger/get-ledger.js';
import { ListReservations } from '#src/capacity/application/use-cases/queries/list-reservations/list-reservations.js';
import { GetReservation } from '#src/capacity/application/use-cases/queries/get-reservation/get-reservation.js';
import { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import { ScopeGuard } from './adapters/in/http/auth.js';
import {
  CapacityController,
  GET_CAPACITY,
  GET_RESERVATION,
  RELEASE_RESERVATION,
  RESERVE_CAPACITY,
} from './adapters/in/http/capacity.controller.js';
import { ProblemFilter } from './adapters/in/http/problem.filter.js';
import {
  GET_LEDGER,
  LIST_RESERVATIONS,
  QueriesController,
} from './adapters/in/http/queries.controller.js';

export interface CapacityModuleOptions {
  readonly persistence: Persistence;
  readonly fxMaxAgeSeconds: number;
}

/** Wires ports to PostgreSQL adapters and the HTTP driving adapter (the api role). */
@Module({})
export class CapacityModule {
  static register(options: CapacityModuleOptions): DynamicModule {
    const uow = new PostgresUnitOfWork(options.persistence);
    const reader = new PgCapacityReader(options.persistence.db);
    const queryReader = new PgQueryReader(options.persistence.db);
    return {
      module: CapacityModule,
      controllers: [CapacityController, QueriesController],
      providers: [
        ScopeGuard,
        { provide: APP_FILTER, useClass: ProblemFilter },
        {
          provide: RESERVE_CAPACITY,
          useValue: new ReserveCapacity({
            uow,
            clock: systemClock,
            ids: uuidV7Generator,
            fxMaxAgeMs: options.fxMaxAgeSeconds * 1000,
          }),
        },
        {
          provide: RELEASE_RESERVATION,
          useValue: new ReleaseReservation({ uow, clock: systemClock, ids: uuidV7Generator }),
        },
        { provide: GET_CAPACITY, useValue: new GetCapacity(reader) },
        { provide: GET_RESERVATION, useValue: new GetReservation(reader) },
        { provide: LIST_RESERVATIONS, useValue: new ListReservations(queryReader) },
        { provide: GET_LEDGER, useValue: new GetLedger(queryReader) },
      ],
    };
  }
}
