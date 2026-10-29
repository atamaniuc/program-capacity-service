import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GetCapacity } from '#src/capacity/application/use-cases/queries/get-capacity/get-capacity.js';
import { GetReservation } from '#src/capacity/application/use-cases/queries/get-reservation/get-reservation.js';
import { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import type { Outcome } from '#src/capacity/application/shared/problem.js';
import type { Principal } from '../boundary/auth.js';
import { money, parse, requestIdOf } from '../boundary/parse.js';
import {
  IdempotencyKeyHeader,
  ProgramIdParam,
  ReleaseRequest,
  ReservationParams,
  ReserveRequest,
} from '../boundary/schemas.js';
import { CurrentPrincipal, ScopeGuard, RequireScope } from './auth.js';
import { PROBLEM_CONTENT_TYPE, problemBody } from './problem.js';

export const RESERVE_CAPACITY = Symbol('RESERVE_CAPACITY');
export const RELEASE_RESERVATION = Symbol('RELEASE_RESERVATION');
export const GET_CAPACITY = Symbol('GET_CAPACITY');
export const GET_RESERVATION = Symbol('GET_RESERVATION');

function requestId(request: Request): string {
  return requestIdOf(request.headers['x-request-id'], randomUUID);
}

export function send(response: Response, outcome: Outcome<unknown>): void {
  if (outcome.ok) {
    response.status(outcome.status).json(outcome.value);
  } else {
    response
      .status(outcome.problem.status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(JSON.stringify(problemBody(outcome.problem)));
  }
}

@Controller('v1/programs/:programId')
@UseGuards(ScopeGuard)
export class CapacityController {
  constructor(
    @Inject(RESERVE_CAPACITY) private readonly reserveCapacity: ReserveCapacity,
    @Inject(RELEASE_RESERVATION) private readonly releaseReservation: ReleaseReservation,
    @Inject(GET_CAPACITY) private readonly getCapacity: GetCapacity,
    @Inject(GET_RESERVATION) private readonly getReservation: GetReservation,
  ) {}

  @Get('capacity')
  @RequireScope('capacity:read')
  async capacity(
    @Param() params: unknown,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { programId } = parse(ProgramIdParam, params, 'programId');
    const outcome = await this.getCapacity.execute({ tenantId: principal.tenantId, programId });
    if (outcome.ok) {
      const etag = `"${outcome.value.version}"`;
      response.setHeader('ETag', etag);
      if (request.headers['if-none-match'] === etag) {
        response.status(304).end();
        return;
      }
    }
    send(response, outcome);
  }

  @Post('reservations')
  @RequireScope('capacity:write')
  async reserve(
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { programId } = parse(ProgramIdParam, params, 'programId');
    const { 'idempotency-key': idempotencyKey } = parse(IdempotencyKeyHeader, headers, 'header');
    const payload = parse(ReserveRequest, body, 'body');
    const outcome = await this.reserveCapacity.execute({
      tenantId: principal.tenantId,
      actor: principal.actor,
      requestId: requestId(request),
      idempotencyKey,
      programId,
      invoiceId: payload.invoiceId,
      invoiceAmount: money(payload.amount, 'amount'),
    });
    if (outcome.ok && outcome.status === 201) {
      response.setHeader(
        'Location',
        `/v1/programs/${encodeURIComponent(programId)}/reservations/${outcome.value.reservationId}`,
      );
    }
    send(response, outcome);
  }

  @Get('reservations/:reservationId')
  @RequireScope('capacity:read')
  async reservation(
    @Param() params: unknown,
    @CurrentPrincipal() principal: Principal,
    @Res() response: Response,
  ): Promise<void> {
    const { programId, reservationId } = parse(ReservationParams, params, 'path');
    send(
      response,
      await this.getReservation.execute({ tenantId: principal.tenantId, programId, reservationId }),
    );
  }

  @Post('reservations/:reservationId/releases')
  @RequireScope('capacity:write')
  async release(
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { programId, reservationId } = parse(ReservationParams, params, 'path');
    const { 'idempotency-key': idempotencyKey } = parse(IdempotencyKeyHeader, headers, 'header');
    const payload = parse(ReleaseRequest, body, 'body');
    send(
      response,
      await this.releaseReservation.execute({
        tenantId: principal.tenantId,
        actor: principal.actor,
        requestId: requestId(request),
        idempotencyKey,
        programId,
        reservationId,
        releaseRef: payload.releaseRef,
        amount: payload.amount === undefined ? undefined : money(payload.amount, 'amount'),
        reason: payload.reason,
      }),
    );
  }
}
