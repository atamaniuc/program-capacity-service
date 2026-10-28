import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { traceContextMixin } from '../telemetry/trace-context.js';

export type { Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({ level, base: { service: 'program-capacity' }, mixin: traceContextMixin });
}

/** Routes Nest's own log calls through the same pino instance, so every line is JSON. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.logger.info({ context: contextOf(rest) }, String(message));
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.logger.error({ context: contextOf(rest) }, String(message));
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.logger.warn({ context: contextOf(rest) }, String(message));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.logger.debug({ context: contextOf(rest) }, String(message));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.logger.trace({ context: contextOf(rest) }, String(message));
  }
}

function contextOf(rest: unknown[]): string | undefined {
  const last = rest[rest.length - 1];
  return typeof last === 'string' ? last : undefined;
}
