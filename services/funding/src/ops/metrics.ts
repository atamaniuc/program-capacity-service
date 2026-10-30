import { Counter, Gauge, type Registry } from 'prom-client';
import type { Claim, SagaStats } from '../funding/application/saga-ports.js';
import type { Transition } from '../funding/domain/index.js';

const STATES = [
  'RECEIVED',
  'RESERVING',
  'DISBURSING',
  'COMPENSATING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'NEEDS_ATTENTION',
] as const;

export interface SagaMetrics {
  /** Record one committed transition (step attempts by class, final states). */
  recorded(claim: Claim, transition: Transition): void;
  /** The driver loop ticked: liveness for readiness. */
  heartbeat(): void;
  lastHeartbeatMs(): number;
}

/**
 * ADR 025 metrics: requests per state, age of the oldest request per non-terminal state, step
 * attempts by step and class, requests by final state. The gauges are read from the database on
 * each scrape (`snapshot`), so they are right after a restart.
 */
export function registerSagaMetrics(
  registry: Registry,
  snapshot: () => Promise<SagaStats>,
): SagaMetrics {
  const attempts = new Counter({
    name: 'funding_step_attempts_total',
    help: 'Saga step attempts by step and outcome class',
    labelNames: ['step', 'class'],
    registers: [registry],
  });
  const finals = new Counter({
    name: 'funding_requests_final_total',
    help: 'Funding requests that reached a final or parked state',
    labelNames: ['state'],
    registers: [registry],
  });
  new Gauge({
    name: 'funding_requests',
    help: 'Funding requests per state',
    labelNames: ['state'],
    registers: [registry],
    async collect() {
      const { counts } = await snapshot();
      this.reset();
      for (const state of STATES) this.set({ state }, counts.get(state) ?? 0);
    },
  });
  new Gauge({
    name: 'funding_oldest_request_age_seconds',
    help: 'Age of the oldest request per non-terminal state',
    labelNames: ['state'],
    registers: [registry],
    async collect() {
      const { oldestAgeSeconds } = await snapshot();
      this.reset();
      for (const [state, age] of oldestAgeSeconds) this.set({ state }, age);
    },
  });
  new Gauge({
    name: 'funding_unresolved_reserve_oldest_age_seconds',
    help: 'Age of the oldest compensating request whose reservation is still unknown',
    registers: [registry],
    async collect() {
      this.set((await snapshot()).oldestUnresolvedReserveAgeSeconds);
    },
  });
  let last = Date.now();
  return {
    recorded: (_claim, transition) => {
      attempts.inc({ step: transition.attempt.step, class: transition.attempt.class });
      const state = transition.request.state;
      if (
        state === 'COMPLETED' ||
        state === 'REJECTED' ||
        state === 'FAILED' ||
        state === 'NEEDS_ATTENTION'
      ) {
        finals.inc({ state });
      }
    },
    heartbeat: () => {
      last = Date.now();
    },
    lastHeartbeatMs: () => last,
  };
}

/** Readiness of the worker's driver loop: it must have ticked within `maxAgeMs`. */
export function loopAlive(
  metrics: Pick<SagaMetrics, 'lastHeartbeatMs'>,
  maxAgeMs: number,
  now: () => number = Date.now,
): () => Promise<void> {
  return () =>
    now() - metrics.lastHeartbeatMs() <= maxAgeMs
      ? Promise.resolve()
      : Promise.reject(new Error('driver loop stalled'));
}
