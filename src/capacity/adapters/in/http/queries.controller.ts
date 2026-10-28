import { Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { GetLedger } from '#src/capacity/application/use-cases/queries/get-ledger/get-ledger.js';
import { ListReservations } from '#src/capacity/application/use-cases/queries/list-reservations/list-reservations.js';
import { CurrentPrincipal, RequireScope, ScopeGuard, type Principal } from './auth.js';
import { parse, send } from './capacity.controller.js';
import { LedgerQuery, ListReservationsQuery } from './query-schemas.js';
import { ProgramIdParam } from './schemas.js';

export const LIST_RESERVATIONS = Symbol('LIST_RESERVATIONS');
export const GET_LEDGER = Symbol('GET_LEDGER');

/** FR-12: the read side that lets an operator explain every number. */
@Controller('v1/programs/:programId')
@UseGuards(ScopeGuard)
export class QueriesController {
  constructor(
    @Inject(LIST_RESERVATIONS) private readonly listReservations: ListReservations,
    @Inject(GET_LEDGER) private readonly getLedger: GetLedger,
  ) {}

  @Get('reservations')
  @RequireScope('capacity:read')
  async reservations(
    @Param() params: unknown,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Res() response: Response,
  ): Promise<void> {
    const { programId } = parse(ProgramIdParam, params, 'programId');
    const filters = parse(ListReservationsQuery, query, 'query');
    send(
      response,
      await this.listReservations.execute({
        tenantId: principal.tenantId,
        programId,
        limit: filters.limit,
        ...(filters.invoiceId === undefined ? {} : { invoiceId: filters.invoiceId }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
      }),
    );
  }

  @Get('ledger')
  @RequireScope('capacity:read')
  async ledger(
    @Param() params: unknown,
    @Query() query: unknown,
    @CurrentPrincipal() principal: Principal,
    @Res() response: Response,
  ): Promise<void> {
    const { programId } = parse(ProgramIdParam, params, 'programId');
    const page = parse(LedgerQuery, query, 'query');
    send(
      response,
      await this.getLedger.execute({
        tenantId: principal.tenantId,
        programId,
        limit: page.limit,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      }),
    );
  }
}
