import { err, ok, type Result } from './result.js';

/** Capacity keeps an Idempotency-Key for 24 hours (NFR-11). */
export const CAPACITY_KEY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Business deadlines of the saga (ADR 025), in milliseconds. */
export interface SagaConfig {
  /** Normal path: unknown Reserve outcomes are retried until then. */
  readonly reserveDeadlineMs: number;
  /** Unknown disbursements are retried until then, then NEEDS_ATTENTION. */
  readonly disburseDeadlineMs: number;
  /** Resolving an unknown reservation by repeating Reserve; must stay below the key retention. */
  readonly reserveResolutionLimitMs: number;
}

export const DEFAULT_SAGA_CONFIG: SagaConfig = {
  reserveDeadlineMs: 2 * 60 * 1000,
  disburseDeadlineMs: 15 * 60 * 1000,
  reserveResolutionLimitMs: 12 * 60 * 60 * 1000,
};

export type SagaConfigError =
  | 'deadline-not-positive'
  | 'resolution-limit-reaches-key-retention'
  | 'resolution-before-reserve-deadline';

function isPositiveInteger(value: number): boolean {
  return value > 0 && value < Infinity && Math.floor(value) === value;
}

/** Boot-time validation: a repeat of Reserve must still be inside capacity's key retention. */
export function validateSagaConfig(config: SagaConfig): Result<SagaConfig, SagaConfigError> {
  if (
    !isPositiveInteger(config.reserveDeadlineMs) ||
    !isPositiveInteger(config.disburseDeadlineMs) ||
    !isPositiveInteger(config.reserveResolutionLimitMs)
  ) {
    return err('deadline-not-positive');
  }
  if (config.reserveResolutionLimitMs >= CAPACITY_KEY_RETENTION_MS) {
    return err('resolution-limit-reaches-key-retention');
  }
  if (config.reserveResolutionLimitMs < config.reserveDeadlineMs) {
    return err('resolution-before-reserve-deadline');
  }
  return ok(config);
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 60_000;

/**
 * Capped exponential backoff with full jitter: 0.5 s doubling, cap 60 s. `random` is a value in
 * [0, 1) supplied by the caller, so the function stays pure.
 */
export function backoffDelayMs(attempts: number, random: number): number {
  const exponent = Math.min(Math.max(attempts, 0), 30);
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  return Math.floor(random * ceiling);
}
