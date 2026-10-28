import type { CurrencyCode } from './money.js';
import { err, ok, type Result } from './result.js';

export type ProgramStatus = 'ACTIVE' | 'SUSPENDED';

/** The capacity projection of one program; the only hot row (PRD §6). */
export interface Program {
  readonly tenantId: string;
  readonly id: string;
  readonly currency: CurrencyCode;
  readonly creditLimitMinor: bigint;
  readonly reservedMinor: bigint;
  readonly status: ProgramStatus;
  readonly version: number;
  readonly treasurySeq: number;
  readonly platformSeq: number;
}

export type ReserveRejection = 'program-suspended' | 'program-over-limit' | 'insufficient-capacity';

/** Available capacity, never negative. */
export function availableMinor(program: Program): bigint {
  const free = program.creditLimitMinor - program.reservedMinor;
  return free > 0n ? free : 0n;
}

/** How far reserved exceeds the credit limit after a limit cut; zero otherwise. */
export function overLimitByMinor(program: Program): bigint {
  const excess = program.reservedMinor - program.creditLimitMinor;
  return excess > 0n ? excess : 0n;
}

/** reserved ÷ limit as a decimal string with four places, rounded down; "0.0000" for a zero limit. */
export function utilization(program: Program): string {
  if (program.creditLimitMinor === 0n) return '0.0000';
  const basisPoints = (program.reservedMinor * 10_000n) / program.creditLimitMinor;
  const digits = basisPoints.toString().padStart(5, '0');
  return `${digits.slice(0, digits.length - 4)}.${digits.slice(digits.length - 4)}`;
}

/** I2: a reservation needs an ACTIVE program and `limit − reserved ≥ amount`. */
export function checkReserve(
  program: Program,
  amountMinor: bigint,
): Result<true, ReserveRejection> {
  if (program.status === 'SUSPENDED') return err('program-suspended');
  if (program.reservedMinor > program.creditLimitMinor) return err('program-over-limit');
  if (program.creditLimitMinor - program.reservedMinor < amountMinor) {
    return err('insufficient-capacity');
  }
  return ok(true);
}
