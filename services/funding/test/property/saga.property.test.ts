import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAGA_CONFIG,
  applyOutcome,
  isTerminal,
  nextCommand,
  receiveFundingRequest,
  stepKey,
  type Command,
  type DisburseOutcome,
  type FundingRequest,
  type ReleaseOutcome,
  type ReserveOutcome,
  type StepOutcome,
} from '#src/funding/domain/index.js';

/** What is really true outside the saga; outcomes are drawn consistently with it. */
interface World {
  /** Capacity holds a reservation created under the saga's reserve key. */
  held: boolean;
  /** The rail moved money under the saga's disburse key. */
  paid: boolean;
}

const HOUR = 3_600_000;
const step = fc.record({
  pick: fc.integer({ min: 0, max: 9 }),
  dt: fc.constantFrom(0, 1_000, 30_000, 130_000, 20 * 60_000, HOUR, 13 * HOUR),
  random: fc.double({ min: 0, max: 0.999, noNaN: true }),
  approve: fc.boolean(),
  problem: fc.constantFrom(
    'insufficient-capacity',
    'fx-rate-unavailable',
    'reservation-conflict',
    'not-found',
  ),
});
type Draw = typeof step extends fc.Arbitrary<infer T> ? T : never;

const ZERO_AMOUNT = { minor: 100_000n, currency: 'USD' } as const;

function newRequest(): FundingRequest {
  const created = receiveFundingRequest(
    { id: 'fr-1', tenantId: 't', programId: 'p', invoiceId: 'inv', amount: ZERO_AMOUNT },
    0,
  );
  if (!created.ok) throw new Error('fixture');
  return created.value;
}

interface Trace {
  keys: Map<string, Set<string>>;
  created: Set<string>;
  paidSeen: boolean;
  releaseIssued: boolean;
  lastDisburse?: DisburseOutcome['kind'];
}

/** Draws the outcome of `command` that the world allows. */
function draw(command: Command, world: World, d: Draw, trace: Trace): StepOutcome {
  switch (command.step) {
    case 'risk':
      return {
        step: 'risk',
        decision: d.approve ? { approved: true } : { approved: false, reason: 'risk-declined' },
      };
    case 'reserve': {
      let outcome: ReserveOutcome;
      if (world.held) {
        outcome =
          d.pick % 2 === 0 ? { kind: 'created', reservationId: 'res-1' } : { kind: 'unknown' };
      } else if (d.pick < 3) {
        world.held = true;
        outcome = { kind: 'created', reservationId: 'res-1' };
      } else if (d.pick < 5) {
        world.held = true; // landed, the answer was lost
        outcome = { kind: 'unknown' };
      } else if (d.pick < 7) {
        outcome = { kind: 'unknown' }; // never landed
      } else if (d.pick < 9) {
        outcome = { kind: 'failure', problem: d.problem };
      } else {
        outcome = { kind: 'existing' }; // someone else's reservation
      }
      if (outcome.kind === 'created') trace.created.add(outcome.reservationId);
      return { step: 'reserve', outcome };
    }
    case 'disburse': {
      let outcome: DisburseOutcome;
      if (world.paid) {
        outcome = d.pick % 2 === 0 ? { kind: 'paid', paymentId: 'pay-1' } : { kind: 'unknown' };
      } else if (d.pick < 3) {
        world.paid = true;
        outcome = { kind: 'paid', paymentId: 'pay-1' };
      } else if (d.pick < 5) {
        world.paid = true; // money moved, the answer was lost
        outcome = { kind: 'unknown' };
      } else if (d.pick < 7) {
        outcome = { kind: 'unknown' };
      } else {
        outcome = { kind: 'declined' };
      }
      if (outcome.kind === 'paid') trace.paidSeen = true;
      trace.lastDisburse = outcome.kind;
      return { step: 'disburse', outcome };
    }
    case 'release': {
      let outcome: ReleaseOutcome;
      if (d.pick < 3) {
        world.held = false;
        outcome = { kind: 'released' };
      } else if (d.pick < 5) {
        world.held = false; // released, the answer was lost
        outcome = { kind: 'unknown' };
      } else if (d.pick < 9) {
        outcome = { kind: 'unknown' };
      } else {
        outcome = { kind: 'failure', problem: 'not-found' };
      }
      return { step: 'release', outcome };
    }
  }
}

describe('saga properties (ADR 025)', () => {
  it('FS-01 S1-S6 hold over random outcome sequences', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 60 }), (draws) => {
        let request = newRequest();
        const world: World = { held: false, paid: false };
        const trace: Trace = {
          keys: new Map(),
          created: new Set(),
          paidSeen: false,
          releaseIssued: false,
        };
        let now = 0;

        for (const d of draws) {
          const command = nextCommand(request);
          if (command === undefined) break;
          now += d.dt;

          // S6: every call of a step carries that step's deterministic key.
          if (command.step !== 'risk') {
            expect(command.key).toBe(stepKey(request.id, command.step));
            const seen = trace.keys.get(command.step) ?? new Set<string>();
            seen.add(command.key);
            trace.keys.set(command.step, seen);
            expect(seen.size).toBe(1);
          }

          if (command.step === 'release') {
            // S3: Release only for a reservation the saga created under its key.
            expect(trace.created.has(command.reservationId)).toBe(true);
            expect(request.reservationId).toBe(command.reservationId);
            // Held, or an earlier release landed and only its answer was lost (replayed by the key).
            expect(world.held || trace.releaseIssued).toBe(true);
            trace.releaseIssued = true;
            // S4: no compensation once a disbursement is PAID or its outcome is unknown.
            expect(world.paid).toBe(false);
            expect(trace.paidSeen).toBe(false);
            // Either no disbursement was attempted, or the rail definitely declined.
            expect([undefined, 'declined']).toContain(trace.lastDisburse);
          }

          const result = applyOutcome(request, draw(command, world, d, trace), {
            now,
            config: DEFAULT_SAGA_CONFIG,
            random: d.random,
          });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          request = result.value.request;

          if (request.state === 'COMPLETED') {
            // S2: a reservation created under the saga's key and a PAID disbursement.
            expect(request.reservationId).toBeDefined();
            expect(trace.created.has(request.reservationId ?? '')).toBe(true);
            expect(request.paymentId).toBeDefined();
            expect(trace.paidSeen).toBe(true);
            expect(world.paid).toBe(true);
          }
          if (request.state === 'REJECTED' || request.state === 'FAILED') {
            // S5: the saga holds no capacity.
            expect(world.held).toBe(false);
          }
          if (request.state === 'NEEDS_ATTENTION' && request.reason === 'disbursement-unknown') {
            // An unknown disbursement parks the request with the reservation still held.
            expect(world.held).toBe(true);
          }
        }

        // S1: a terminal state never changes, whatever arrives.
        if (isTerminal(request.state)) {
          const before = structuredClone(request);
          const late: StepOutcome[] = [
            { step: 'risk', decision: { approved: true } },
            { step: 'reserve', outcome: { kind: 'created', reservationId: 'res-9' } },
            { step: 'disburse', outcome: { kind: 'paid', paymentId: 'pay-9' } },
            { step: 'release', outcome: { kind: 'released' } },
          ];
          for (const outcome of late) {
            const result = applyOutcome(request, outcome, {
              now: now + HOUR,
              config: DEFAULT_SAGA_CONFIG,
              random: 0.5,
            });
            expect(result).toEqual({ ok: false, error: 'terminal' });
          }
          expect(request).toEqual(before);
          expect(nextCommand(request)).toBeUndefined();
        }
      }),
      { numRuns: 500 },
    );
  });

  it('FS-01 compensation with a known reservation never leaves COMPENSATING on an unknown outcome', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom(0, HOUR, 13 * HOUR, 100 * 24 * HOUR),
            fc.double({ min: 0, max: 0.999, noNaN: true }),
          ),
          {
            minLength: 1,
            maxLength: 40,
          },
        ),
        (steps) => {
          let request: FundingRequest = {
            ...newRequest(),
            state: 'COMPENSATING',
            reservationId: 'res-1',
            reason: 'payment-declined',
          };
          let now = 0;
          for (const [dt, random] of steps) {
            now += dt;
            const result = applyOutcome(
              request,
              { step: 'release', outcome: { kind: 'unknown' } },
              { now, config: DEFAULT_SAGA_CONFIG, random },
            );
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.request.state).toBe('COMPENSATING');
            expect(result.value.event).toBeUndefined();
            expect(result.value.request.nextAttemptAt).toBeGreaterThanOrEqual(now);
            request = result.value.request;
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
