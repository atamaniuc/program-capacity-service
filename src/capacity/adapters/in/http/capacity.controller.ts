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
import type { ZodType } from 'zod';
import { GetCapacity } from '#src/capacity/application/use-cases/queries/get-capacity/get-capacity.js';
import { GetReservation } from '#src/capacity/application/use-cases/queries/get-reservation/get-reservation.js';
import { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import type { Outcome } from '#src/capacity/application/shared/problem.js';
import { parseMoney, type Money } from '#src/capacity/domain/index.js';
import { CurrentPrincipal, ScopeGuard, RequireScope, type Principal } from './auth.js';
import { PROBLEM_CONTENT_TYPE, problemBody, validationProblem } from './problem.js';
import {
  IdempotencyKeyHeader,
  ProgramIdParam,
  ReleaseRequest,
  ReservationParams,
  ReserveRequest,
} from './schemas.js';

export const RESERVE_CAPACITY = Symbol('RESERVE_CAPACITY');
export const RELEASE_RESERVATION = Symbol('RELEASE_RESERVATION');
export const GET_CAPACITY = Symbol('GET_CAPACITY');
export const GET_RESERVATION = Symbol('GET_RESERVATION');

function parse<T>(schema: ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw validationProblem(
      `${what}${path === '' ? '' : `.${path}`}: ${issue?.message ?? 'is invalid'}`,
    );
  }
  return result.data;
}

function money(amount: { value: string; currency: string }, field: string): Money {
  const parsed = parseMoney(amount.value, amount.currency);
  if (parsed.ok) return parsed.value;
  const reasons = {
    'unsupported-currency': `${field}.currency is not a supported ISO 4217 code`,
    'malformed-amount': `${field}.value must be an unsigned decimal string such as "1250.50"`,
    'wrong-scale': `${field}.value must have exactly the minor-unit digits of ${amount.currency}`,
    'amount-too-large': `${field}.value is too large`,
  } as const;
  throw validationProblem(reasons[parsed.error]);
}

function requestId(request: Request): string {
  const supplied = request.headers['x-request-id'];
  return typeof supplied === 'string' && /^[\x21-\x7e]{1,128}$/.test(supplied)
    ? supplied
    : randomUUID();
}

function send(response: Response, outcome: Outcome<unknown>): void {
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
