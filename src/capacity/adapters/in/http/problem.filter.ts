import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { BoundaryProblem } from '../boundary/problem.js';
import {
  HttpProblem,
  PROBLEM_CONTENT_TYPE,
  fromBoundary,
  problemBody,
  type ProblemBody,
} from './problem.js';

/** PostgreSQL conditions that mean "try again later", not "the request is wrong". */
const TRANSIENT_PG_CODES = new Set(['55P03', '57014', '40001', '40P01', '57P01', '08006', '08001']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

function isTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' && (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code))
  );
}

function fromHttpException(exception: HttpException): ProblemBody {
  const status = exception.getStatus();
  if (status === 404) {
    return problemBody({
      type: 'not-found',
      title: 'Not found',
      status,
      detail: 'Resource not found.',
    });
  }
  if (status === 401) {
    return problemBody({
      type: 'unauthorized',
      title: 'Unauthorized',
      status,
      detail: 'Authentication is required.',
    });
  }
  if (status === 403) {
    return problemBody({
      type: 'forbidden',
      title: 'Forbidden',
      status,
      detail: 'Access is denied.',
    });
  }
  if (status === 413) {
    return problemBody({
      type: 'payload-too-large',
      title: 'Payload too large',
      status,
      detail: 'The request body exceeds the size limit.',
    });
  }
  if (status < 500) {
    return problemBody({
      type: 'validation-error',
      title: 'Validation error',
      status,
      detail:
        status === 400 ? 'The request body is not valid JSON.' : 'The request cannot be processed.',
    });
  }
  return problemBody({
    type: 'internal-error',
    title: 'Internal error',
    status,
    detail: 'The request failed.',
  });
}

export interface ProblemResponse {
  readonly body: ProblemBody;
  readonly headers: Readonly<Record<string, string>>;
}

const logger = new Logger('ProblemFilter');

/** Maps any thrown value to the problem the client sees; internals go to the log only. */
export function toProblemResponse(exception: unknown): ProblemResponse {
  if (exception instanceof BoundaryProblem) return toProblemResponse(fromBoundary(exception));
  if (exception instanceof HttpProblem) {
    return { body: exception.problem, headers: exception.headers };
  }
  if (exception instanceof HttpException)
    return { body: fromHttpException(exception), headers: {} };
  if (isTransient(exception)) {
    logger.warn(`transient failure: ${String(exception)}`);
    return {
      body: problemBody({
        type: 'service-unavailable',
        title: 'Service unavailable',
        status: 503,
        detail: 'The service could not complete the request in time; retry later.',
      }),
      headers: { 'Retry-After': '1' },
    };
  }
  logger.error(
    exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
  );
  return {
    body: problemBody({
      type: 'internal-error',
      title: 'Internal error',
      status: 500,
      detail: 'The request failed; retry later.',
    }),
    headers: {},
  };
}

export function writeProblem(response: Response, exception: unknown): void {
  const { body, headers } = toProblemResponse(exception);
  response.status(body.status);
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
}

/** Every error leaves as `application/problem+json`. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    writeProblem(host.switchToHttp().getResponse<Response>(), exception);
  }
}
