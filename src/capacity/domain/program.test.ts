import { describe, expect, it } from 'vitest';
import {
  availableMinor,
  checkReserve,
  overLimitByMinor,
  utilization,
  type Program,
} from './program.js';
import { hasSameTerms, remainingMinor, type Reservation } from './reservation.js';

const program: Program = {
  tenantId: 'bank-a',
  id: 'prg',
  currency: 'USD',
  creditLimitMinor: 1_000_000_000n,
  reservedMinor: 900_000_000n,
  status: 'ACTIVE',
  version: 3,
  treasurySeq: 1,
  platformSeq: 3,
};

describe('Program capacity policy', () => {
  it('T2 computes available, over-limit and utilization', () => {
    expect(availableMinor(program)).toBe(100_000_000n);
    expect(overLimitByMinor(program)).toBe(0n);
    expect(utilization(program)).toBe('0.9000');
    const cut = { ...program, creditLimitMinor: 300_000_000n, reservedMinor: 362_000_000n };
    expect(availableMinor(cut)).toBe(0n);
    expect(overLimitByMinor(cut)).toBe(62_000_000n);
    expect(utilization(cut)).toBe('1.2066');
    expect(utilization({ ...program, creditLimitMinor: 0n, reservedMinor: 0n })).toBe('0.0000');
    expect(utilization({ ...program, reservedMinor: 0n })).toBe('0.0000');
  });

  it('T2 admits a reservation that fits exactly and refuses one minor unit more', () => {
    expect(checkReserve(program, 100_000_000n)).toEqual({ ok: true, value: true });
    expect(checkReserve(program, 100_000_001n)).toEqual({
      ok: false,
      error: 'insufficient-capacity',
    });
  });

  it('T2 refuses suspended and over-limit programs before looking at the amount', () => {
    expect(checkReserve({ ...program, status: 'SUSPENDED' }, 1n)).toEqual({
      ok: false,
      error: 'program-suspended',
    });
    expect(checkReserve({ ...program, creditLimitMinor: 800_000_000n }, 1n)).toEqual({
      ok: false,
      error: 'program-over-limit',
    });
  });
});

describe('Reservation terms', () => {
  const reservation: Reservation = {
    id: 'r1',
    tenantId: 'bank-a',
    programId: 'prg',
    invoiceId: 'INV-1',
    invoiceAmount: { minor: 100_000_000n, currency: 'EUR' },
    fx: { rate: { scaled: 11_000_000_000n }, source: 'treasury', at: new Date(0) },
    amountMinor: 110_000_000n,
    releasedMinor: 10_000_000n,
    releasedInvoiceMinor: 9_000_000n,
    status: 'PARTIALLY_RELEASED',
    origin: 'API',
    platformSeq: 1,
    createdAt: new Date(0),
  };

  it('T2 compares invoice amount and currency for natural-key replay', () => {
    expect(hasSameTerms(reservation, { minor: 100_000_000n, currency: 'EUR' })).toBe(true);
    expect(hasSameTerms(reservation, { minor: 100_000_001n, currency: 'EUR' })).toBe(false);
    expect(hasSameTerms(reservation, { minor: 100_000_000n, currency: 'GBP' })).toBe(false);
    expect(remainingMinor(reservation)).toBe(100_000_000n);
  });
});
