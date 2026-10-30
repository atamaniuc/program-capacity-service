import {
  applyOutcome,
  assessRisk,
  nextCommand,
  type Command,
  type RiskPolicy,
  type SagaConfig,
  type StepOutcome,
  type Transition,
} from '../domain/index.js';
import type { CapacityGateway, Claim, PaymentRail, SagaStore } from './saga-ports.js';

export interface DriverSettings {
  readonly owner: string;
  readonly leaseMs: number;
  readonly batchSize: number;
  readonly saga: SagaConfig;
  readonly risk: RiskPolicy;
}

export interface DriverHooks {
  /** A transition raised an alert (FundingNeedsAttention). */
  readonly onAlert?: (claim: Claim, transition: Transition) => void;
  /** The result of a step was dropped: the lease was lost or the step is no longer due. */
  readonly onDropped?: (claim: Claim, reason: 'lease-lost' | 'not-due') => void;
  /** A transition committed. */
  readonly onRecorded?: (claim: Claim, transition: Transition) => void;
  readonly onError?: (claim: Claim, error: unknown) => void;
  /** Test seam: runs between the call and the record. */
  readonly beforeRecord?: (claim: Claim, outcome: StepOutcome) => Promise<void>;
}

/**
 * The driver loop body of ADR 025: claim, call outside any transaction, record with the version
 * check. A step is repeated until it gets a definite answer; the receivers deduplicate by key.
 */
export class SagaDriver {
  constructor(
    private readonly store: SagaStore,
    private readonly capacity: CapacityGateway,
    private readonly rail: PaymentRail,
    private readonly settings: DriverSettings,
    private readonly hooks: DriverHooks = {},
    private readonly random: () => number = Math.random,
  ) {}

  /** Claims one batch and runs each step; returns how many steps were executed. */
  async runOnce(): Promise<number> {
    const claims = await this.store.claimDue(
      this.settings.owner,
      this.settings.leaseMs,
      this.settings.batchSize,
    );
    await Promise.all(claims.map((claim) => this.runStep(claim)));
    return claims.length;
  }

  async runStep(claim: Claim): Promise<void> {
    const command = nextCommand(claim.request);
    if (command === undefined) {
      this.hooks.onDropped?.(claim, 'not-due');
      return;
    }
    try {
      const outcome = await this.execute(claim, command);
      await this.hooks.beforeRecord?.(claim, outcome);
      const now = await this.store.now();
      const applied = applyOutcome(claim.request, outcome, {
        now,
        config: this.settings.saga,
        random: this.random(),
      });
      if (!applied.ok) {
        this.hooks.onDropped?.(claim, 'not-due');
        return;
      }
      const recorded = await this.store.record(claim, applied.value);
      if (!recorded) {
        this.hooks.onDropped?.(claim, 'lease-lost');
        return;
      }
      this.hooks.onRecorded?.(claim, applied.value);
      if (applied.value.alert) this.hooks.onAlert?.(claim, applied.value);
    } catch (error) {
      // The lease expires and the step runs again from the persisted state.
      this.hooks.onError?.(claim, error);
    }
  }

  private async execute(claim: Claim, command: Command): Promise<StepOutcome> {
    const { request } = claim;
    switch (command.step) {
      case 'risk':
        return { step: 'risk', decision: assessRisk(request.amount, this.settings.risk) };
      case 'reserve':
        return {
          step: 'reserve',
          outcome: await this.capacity.reserve({
            tenantId: request.tenantId,
            programId: request.programId,
            invoiceId: request.invoiceId,
            amount: request.amount,
            key: command.key,
          }),
        };
      case 'disburse':
        return {
          step: 'disburse',
          outcome: await this.rail.disburse({
            key: command.key,
            invoiceId: request.invoiceId,
            amount: request.amount,
            lookupFirst: command.lookupFirst,
          }),
        };
      case 'release':
        return {
          step: 'release',
          outcome: await this.capacity.release({
            tenantId: request.tenantId,
            programId: request.programId,
            reservationId: command.reservationId,
            releaseRef: command.releaseRef,
            key: command.key,
          }),
        };
    }
  }
}
