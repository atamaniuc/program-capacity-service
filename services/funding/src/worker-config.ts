import * as z from 'zod';
import {
  DEFAULT_SAGA_CONFIG,
  validateSagaConfig,
  type RiskPolicy,
  type SagaConfig,
} from './funding/domain/index.js';

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** `500ms`, `30s`, `2m`, `12h`; a bare integer is milliseconds. */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]) * UNIT_MS[match[2] ?? 'ms']!;
}

const duration = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (text === undefined || text === '') return fallback;
      const parsed = parseDuration(text);
      if (parsed === undefined) {
        ctx.addIssue({ code: 'custom', message: `not a duration: ${text}` });
        return z.NEVER;
      }
      return parsed;
    });

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** Per-currency limit on one invoice, in minor units, e.g. `USD=100000000,EUR=100000000`. */
const riskLimits = z
  .string()
  .default('USD=100000000,EUR=100000000,GBP=100000000')
  .transform((text, ctx) => {
    const limits: Record<string, bigint> = {};
    for (const part of text.split(',').filter((p) => p !== '')) {
      const match = /^([A-Z]{3})=([1-9]\d*)$/.exec(part.trim());
      if (match?.[1] === undefined || match[2] === undefined) {
        ctx.addIssue({ code: 'custom', message: `not CCC=<minor units>: ${part}` });
        return z.NEVER;
      }
      limits[match[1]] = BigInt(match[2]);
    }
    return limits;
  });

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  OPS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  CAPACITY_GRPC_TARGET: z.string().min(1),
  OAUTH_TOKEN_URL: z.string().min(1),
  /** The issuer's `Host` when the token URL is not the issuer's own address. */
  OAUTH_ISSUER_HOST: z.string().min(1).optional(),
  OAUTH_CLIENT_SECRET: z.string().min(1).default('funding-service'),
  PAYMENTS_BASE_URL: z.string().min(1),
  FUNDING_GRPC_DEADLINE_MS: positiveInt(21_000),
  FUNDING_PAYMENT_TIMEOUT_MS: positiveInt(5_000),
  FUNDING_TOKEN_TIMEOUT_MS: positiveInt(5_000),
  FUNDING_STEP_LEASE: duration(60_000),
  FUNDING_POLL_INTERVAL: duration(500),
  FUNDING_BATCH_SIZE: positiveInt(10),
  FUNDING_RESERVE_DEADLINE: duration(DEFAULT_SAGA_CONFIG.reserveDeadlineMs),
  FUNDING_DISBURSE_DEADLINE: duration(DEFAULT_SAGA_CONFIG.disburseDeadlineMs),
  FUNDING_RESERVE_RESOLUTION_LIMIT: duration(DEFAULT_SAGA_CONFIG.reserveResolutionLimitMs),
  FUNDING_RISK_LIMITS: riskLimits,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** Capacity's `lock_timeout` plus `statement_timeout` (5 s + 15 s): a call must outlast it. */
const CAPACITY_TRANSACTION_BUDGET_MS = 20_000;

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly opsPort: number;
  readonly capacityTarget: string;
  readonly tokenUrl: string;
  readonly issuerHost: string | undefined;
  readonly clientSecret: string;
  readonly paymentsBaseUrl: string;
  readonly grpcDeadlineMs: number;
  readonly paymentTimeoutMs: number;
  readonly tokenTimeoutMs: number;
  readonly leaseMs: number;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly saga: SagaConfig;
  readonly risk: RiskPolicy;
}

/**
 * Parses the environment once at boot (ADR 025): a resolution limit that reaches capacity's
 * 24 h key retention (or a reserve window that does, with the retry margin), a lease shorter than
 * the longest step, or a deadline below capacity's own transaction timeouts stops the process
 * instead of risking a double effect.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const c = parsed.data;
  const saga = validateSagaConfig({
    reserveDeadlineMs: c.FUNDING_RESERVE_DEADLINE,
    disburseDeadlineMs: c.FUNDING_DISBURSE_DEADLINE,
    reserveResolutionLimitMs: c.FUNDING_RESERVE_RESOLUTION_LIMIT,
  });
  if (!saga.ok) throw new Error(`invalid configuration: saga: ${saga.error}`);
  if (c.FUNDING_GRPC_DEADLINE_MS <= CAPACITY_TRANSACTION_BUDGET_MS) {
    throw new Error(
      `invalid configuration: FUNDING_GRPC_DEADLINE_MS must exceed capacity's lock plus statement timeout (${CAPACITY_TRANSACTION_BUDGET_MS.toString()} ms)`,
    );
  }
  // One step can fetch a token, call capacity, get UNAUTHENTICATED, fetch a token again and call
  // once more; a lookup-first disbursement makes two HTTP calls. The lease must outlast both.
  const longestStep = Math.max(
    2 * (c.FUNDING_TOKEN_TIMEOUT_MS + c.FUNDING_GRPC_DEADLINE_MS),
    2 * c.FUNDING_PAYMENT_TIMEOUT_MS,
  );
  if (c.FUNDING_STEP_LEASE <= longestStep) {
    throw new Error(
      `invalid configuration: FUNDING_STEP_LEASE must exceed the longest step (${longestStep.toString()} ms: two attempts of token fetch plus call)`,
    );
  }
  return {
    databaseUrl: c.DATABASE_URL,
    opsPort: c.OPS_PORT,
    capacityTarget: c.CAPACITY_GRPC_TARGET,
    tokenUrl: c.OAUTH_TOKEN_URL,
    issuerHost: c.OAUTH_ISSUER_HOST,
    clientSecret: c.OAUTH_CLIENT_SECRET,
    paymentsBaseUrl: c.PAYMENTS_BASE_URL,
    grpcDeadlineMs: c.FUNDING_GRPC_DEADLINE_MS,
    paymentTimeoutMs: c.FUNDING_PAYMENT_TIMEOUT_MS,
    tokenTimeoutMs: c.FUNDING_TOKEN_TIMEOUT_MS,
    leaseMs: c.FUNDING_STEP_LEASE,
    pollIntervalMs: c.FUNDING_POLL_INTERVAL,
    batchSize: c.FUNDING_BATCH_SIZE,
    saga: saga.value,
    risk: { limits: c.FUNDING_RISK_LIMITS },
  };
}
