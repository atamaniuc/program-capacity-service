import { status } from '@grpc/grpc-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GrpcCapacityGateway } from '../../src/funding/adapters/out/grpc/capacity-gateway.js';
import type { TenantTokens } from '../../src/funding/application/saga-ports.js';
import {
  created,
  existing,
  released,
  startFakeCapacity,
  type FakeCapacity,
} from '../support/fake-capacity.js';

class Tokens implements TenantTokens {
  issued = 0;
  invalidated: string[] = [];
  tokenFor(tenantId: string): Promise<string> {
    this.issued += 1;
    return Promise.resolve(`jwt-${tenantId}-${this.issued.toString()}`);
  }
  invalidate(tenantId: string): void {
    this.invalidated.push(tenantId);
  }
}

let fake: FakeCapacity;
let tokens: Tokens;
let gateway: GrpcCapacityGateway;

beforeEach(async () => {
  fake = await startFakeCapacity();
  tokens = new Tokens();
  gateway = new GrpcCapacityGateway({ target: fake.target, tokens, deadlineMs: 400 });
});
afterEach(async () => {
  gateway.close();
  await fake.close();
});

const reserve = {
  tenantId: 'bank-a',
  programId: 'prg_1',
  invoiceId: 'inv-1',
  amount: { minor: 125_050n, currency: 'USD' },
  key: 'funding:r1:reserve',
};
const release = {
  tenantId: 'bank-a',
  programId: 'prg_1',
  reservationId: 'res-1',
  releaseRef: 'funding:r1:compensation',
  key: 'funding:r1:release',
};

describe('capacity gateway (ADR 024, ADR 025)', () => {
  it('FS-03 Reserve sends the tenant token, the step key and the amount as a decimal string; CREATED carries the id', async () => {
    fake.onReserve = () => created('res-77');
    expect(await gateway.reserve(reserve)).toEqual({ kind: 'created', reservationId: 'res-77' });
    const call = fake.reserves[0];
    expect(call?.metadata['authorization']).toBe('Bearer jwt-bank-a-1');
    expect(call?.metadata['idempotency-key']).toBe('funding:r1:reserve');
    expect(call?.request).toMatchObject({
      programId: 'prg_1',
      invoiceId: 'inv-1',
      amount: { value: '1250.50', currencyCode: 'USD' },
    });
  });

  it('FS-07 the Reserve body is byte-identical on every attempt and the key never changes', async () => {
    fake.onReserve = (_call, index) =>
      index < 2 ? { error: status.UNAVAILABLE } : created('res-1');
    for (let i = 0; i < 3; i += 1) await gateway.reserve(reserve);
    expect(fake.reserves).toHaveLength(3);
    expect(new Set(fake.reserves.map((c) => Buffer.from(c.bytes).toString('hex'))).size).toBe(1);
    expect(new Set(fake.reserves.map((c) => c.metadata['idempotency-key'])).size).toBe(1);
  });

  it("FS-05 EXISTING is not ours; FAILED_PRECONDITION and ALREADY_EXISTS are definite with capacity's reason", async () => {
    fake.onReserve = () => existing();
    expect(await gateway.reserve(reserve)).toEqual({ kind: 'existing' });
    fake.onReserve = () => ({ error: status.FAILED_PRECONDITION, reason: 'insufficient-capacity' });
    expect(await gateway.reserve(reserve)).toEqual({
      kind: 'failure',
      problem: 'insufficient-capacity',
    });
    fake.onReserve = () => ({ error: status.ALREADY_EXISTS, reason: 'reservation-conflict' });
    expect(await gateway.reserve(reserve)).toEqual({
      kind: 'failure',
      problem: 'reservation-conflict',
    });
  });

  it('FS-07 UNAVAILABLE, INTERNAL and a missed deadline are unknown', async () => {
    fake.onReserve = () => ({ error: status.UNAVAILABLE });
    expect(await gateway.reserve(reserve)).toEqual({ kind: 'unknown' });
    fake.onReserve = () => ({ error: status.INTERNAL });
    expect(await gateway.reserve(reserve)).toEqual({ kind: 'unknown' });
    fake.onReserve = () => ({ hang: true });
    expect(await gateway.reserve(reserve)).toEqual({ kind: 'unknown' });
  });

  it('FS-07 UNAUTHENTICATED refreshes the token once, then the call is repeated; still refused stays unknown', async () => {
    fake.onReserve = (call) =>
      call.metadata['authorization'] === 'Bearer jwt-bank-a-1'
        ? { error: status.UNAUTHENTICATED }
        : created('res-1');
    expect(await gateway.reserve(reserve)).toEqual({ kind: 'created', reservationId: 'res-1' });
    expect(tokens.invalidated).toEqual(['bank-a']);
    expect(fake.reserves).toHaveLength(2);
    fake.reserves.length = 0;
    fake.onReserve = () => ({ error: status.UNAUTHENTICATED });
    expect(await gateway.reserve(reserve)).toEqual({ kind: 'unknown' });
    expect(fake.reserves).toHaveLength(2);
  });

  it('FS-06 Release sends the compensation ref, CANCELLED and no amount (the exact remainder)', async () => {
    fake.onRelease = () => released();
    expect(await gateway.release(release)).toEqual({ kind: 'released' });
    const call = fake.releases[0];
    expect(call?.metadata['idempotency-key']).toBe('funding:r1:release');
    expect(call?.request).toMatchObject({
      programId: 'prg_1',
      reservationId: 'res-1',
      releaseRef: 'funding:r1:compensation',
      reason: 2,
    });
    expect(call?.request.amount).toBeUndefined();
  });

  it('FS-11 release-exceeds-remaining on a final release is a definite success; NOT_FOUND is unexpected, not retried blindly', async () => {
    fake.onRelease = () => ({
      error: status.FAILED_PRECONDITION,
      reason: 'release-exceeds-remaining',
    });
    expect(await gateway.release(release)).toEqual({ kind: 'released' });
    fake.onRelease = () => ({ error: status.NOT_FOUND, reason: 'not-found' });
    expect(await gateway.release(release)).toEqual({ kind: 'failure', problem: 'not-found' });
    fake.onRelease = () => ({ error: status.UNAVAILABLE });
    expect(await gateway.release(release)).toEqual({ kind: 'unknown' });
  });

  it('FS-03 a token that cannot be had is an unknown outcome, not a rejection', async () => {
    const broken = new GrpcCapacityGateway({
      target: fake.target,
      deadlineMs: 400,
      tokens: {
        tokenFor: () => Promise.reject(new Error('issuer down')),
        invalidate: () => undefined,
      },
    });
    expect(await broken.reserve(reserve)).toEqual({ kind: 'unknown' });
    expect(fake.reserves).toHaveLength(0);
    broken.close();
  });
});
