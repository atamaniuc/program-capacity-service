import { describe, expect, it } from 'vitest';
import type { OwnReservation } from '../../ports/index.js';
import {
  impliedRate,
  outstandingOf,
  planReconciliation,
  type ReconcilePolicy,
  type SnapshotReservation,
} from './policy.js';

const policy: ReconcilePolicy = { toleranceMinor: 1n, mode: 'HOLD', skewMs: 300_000 };
const T0 = new Date('2026-10-28T10:00:00Z');

function own(overrides: Partial<OwnReservation> = {}): OwnReservation {
  return {
    id: 'r1',
    invoiceId: 'INV-1',
    invoiceCurrency: 'EUR',
    invoiceAmountMinor: 100_000n,
    releasedInvoiceMinor: 0n,
    amountMinor: 110_000n,
    releasedMinor: 0n,
    status: 'ACTIVE',
    platformSeq: 5,
    createdAt: T0,
    ...overrides,
  };
}

function theirs(overrides: Partial<SnapshotReservation> = {}): SnapshotReservation {
  return {
    invoiceId: 'INV-1',
    invoiceCurrency: 'EUR',
    outstandingInvoiceMinor: 100_000n,
    outstandingProgramMinor: 110_000n,
    ...overrides,
  };
}

const snapshotOf = (reservations: SnapshotReservation[], platformWatermark: number | null) => ({
  asOf: T0,
  platformWatermark,
  reservations,
});

describe('reconciliation policy (PRD §8 case table)', () => {
  it('AC-14 leaves a program amount within tolerance alone and reports it', () => {
    const plan = planReconciliation(
      'USD',
      [own()],
      snapshotOf([theirs({ outstandingProgramMinor: 110_001n })], 9),
      policy,
    );
    expect(plan.overwrites).toEqual([]);
    expect(plan.tolerated).toEqual([{ invoiceId: 'INV-1', programDiffMinor: 1n }]);
    expect(plan.deltaReservedMinor).toBe(0n);
  });

  it('AC-14 stays silent when nothing differs', () => {
    const plan = planReconciliation('USD', [own()], snapshotOf([theirs()], 9), policy);
    expect(plan.tolerated).toEqual([]);
    expect(plan.drifts).toEqual([]);
  });

  it('AC-15 lets treasury win beyond tolerance and when the invoice amount differs', () => {
    const beyond = planReconciliation(
      'USD',
      [own()],
      snapshotOf([theirs({ outstandingProgramMinor: 110_002n })], 9),
      policy,
    );
    expect(beyond.overwrites[0]).toMatchObject({ amountMinor: 110_002n, releasedMinor: 0n });
    expect(beyond.overwrites[0]?.status).toBe('ACTIVE');
    expect(beyond.deltaReservedMinor).toBe(2n);

    const invoice = planReconciliation(
      'USD',
      [own()],
      snapshotOf(
        [theirs({ outstandingInvoiceMinor: 90_000n, outstandingProgramMinor: 99_000n })],
        9,
      ),
      policy,
    );
    expect(invoice.overwrites[0]).toMatchObject({
      releasedInvoiceMinor: 10_000n,
      releasedMinor: 11_000n,
      status: 'PARTIALLY_RELEASED',
      deltaReservedMinor: -11_000n,
    });
    expect(invoice.drifts[0]?.kind).toBe('ADJUSTED');
  });

  it('AC-15 reopens a released reservation and raises the invoice amount when treasury owes more', () => {
    const released = own({
      status: 'RELEASED',
      releasedInvoiceMinor: 100_000n,
      releasedMinor: 110_000n,
    });
    const reopened = planReconciliation('USD', [released], snapshotOf([theirs()], 9), policy);
    expect(reopened.overwrites[0]).toMatchObject({
      releasedInvoiceMinor: 0n,
      releasedMinor: 0n,
      status: 'ACTIVE',
      deltaReservedMinor: 110_000n,
    });

    const bigger = planReconciliation(
      'USD',
      [own()],
      snapshotOf(
        [theirs({ outstandingInvoiceMinor: 150_000n, outstandingProgramMinor: 170_000n })],
        9,
      ),
      policy,
    );
    expect(bigger.overwrites[0]).toMatchObject({
      invoiceAmountMinor: 150_000n,
      amountMinor: 170_000n,
      releasedInvoiceMinor: 0n,
      releasedMinor: 0n,
    });
  });

  it('AC-15 adopts a reservation only treasury knows, with an implied rate', () => {
    const plan = planReconciliation('USD', [], snapshotOf([theirs()], 9), policy);
    expect(plan.adoptions).toHaveLength(1);
    expect(plan.adoptions[0]?.rate.scaled).toBe(11_000_000_000n);
    expect(plan.deltaReservedMinor).toBe(110_000n);
    expect(plan.drifts[0]?.kind).toBe('ADOPTED');
  });

  it('AC-08 keeps an only-ours reservation above the watermark, holds one at or below it', () => {
    const above = planReconciliation('USD', [own({ platformSeq: 58 })], snapshotOf([], 57), policy);
    expect(above).toMatchObject({ keptUnseen: 1, drifts: [], deltaReservedMinor: 0n });

    const atWatermark = planReconciliation(
      'USD',
      [own({ platformSeq: 57 })],
      snapshotOf([], 57),
      policy,
    );
    expect(atWatermark.drifts.map((d) => d.kind)).toEqual(['HELD']);
    expect(atWatermark.deltaReservedMinor).toBe(0n);
  });

  it('AC-08 RELEASE mode closes a seen only-ours reservation; a released one is ignored', () => {
    const plan = planReconciliation(
      'USD',
      [own({ platformSeq: 1 }), own({ id: 'r2', invoiceId: 'INV-2', status: 'RELEASED' })],
      snapshotOf([], 57),
      { ...policy, mode: 'RELEASE' },
    );
    expect(plan.overwrites).toHaveLength(1);
    expect(plan.overwrites[0]).toMatchObject({ status: 'RELEASED', deltaReservedMinor: -110_000n });
    expect(plan.drifts.map((d) => d.kind)).toEqual(['RELEASED']);
  });

  it('AC-08 without a watermark compares creation time with asOf minus the skew margin', () => {
    const recent = own({ createdAt: new Date(T0.getTime() - 60_000) });
    const old = own({ id: 'r2', invoiceId: 'INV-2', createdAt: new Date(T0.getTime() - 600_000) });
    const plan = planReconciliation('USD', [recent, old], snapshotOf([], null), policy);
    expect(plan.usedFallback).toBe(true);
    expect(plan.keptUnseen).toBe(1);
    expect(plan.drifts.map((d) => d.invoiceId)).toEqual(['INV-2']);
  });

  it('computes outstanding amounts and an implied rate that is never zero', () => {
    expect(outstandingOf(own({ releasedInvoiceMinor: 40_000n, releasedMinor: 44_000n }))).toEqual({
      invoiceMinor: 60_000n,
      programMinor: 66_000n,
    });
    expect(impliedRate('JPY', 1_000_000n, 'KWD', 1n).scaled).toBe(10n);
    expect(impliedRate('USD', 1_000_000_000_000n, 'JPY', 1n).scaled).toBe(1n);
  });
});
