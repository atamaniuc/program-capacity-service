import type {
  DisburseOutcome,
  FundingRequest,
  Money,
  ReleaseOutcome,
  ReserveOutcome,
  Transition,
} from '../domain/index.js';

/** A request the driver holds a lease on; `version` is the value the claim wrote (ADR 025). */
export interface Claim {
  readonly request: FundingRequest;
  readonly version: bigint;
  readonly leaseOwner: string;
  /** Database clock at claim time, epoch milliseconds. */
  readonly claimedAt: number;
}

export interface SagaStore {
  /**
   * Short transaction: due rows of a non-terminal state with a free or expired lease,
   * `FOR UPDATE SKIP LOCKED`; sets the lease and bumps the version.
   */
  claimDue(owner: string, leaseMs: number, limit: number): Promise<readonly Claim[]>;
  /** Database clock, epoch milliseconds (time never comes from a worker's own clock). */
  now(): Promise<number>;
  /**
   * One transaction: update the row `WHERE id AND version = claim.version`, append the attempt,
   * insert the outbox row when the transition has an event. False when the lease was lost.
   */
  record(claim: Claim, transition: Transition): Promise<boolean>;
}

export interface ReserveCall {
  readonly tenantId: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly amount: Money;
  /** `funding:<id>:reserve`, identical on every attempt. */
  readonly key: string;
}

export interface ReleaseCall {
  readonly tenantId: string;
  readonly programId: string;
  readonly reservationId: string;
  readonly releaseRef: string;
  readonly key: string;
}

/** Capacity over gRPC; every answer is already classified (ADR 025 outcome table). */
export interface CapacityGateway {
  reserve(call: ReserveCall): Promise<ReserveOutcome>;
  release(call: ReleaseCall): Promise<ReleaseOutcome>;
}

export interface DisburseCall {
  readonly key: string;
  readonly invoiceId: string;
  readonly amount: Money;
  /** After an unknown attempt: ask the rail for the payment by key before posting again. */
  readonly lookupFirst: boolean;
}

export interface PaymentRail {
  disburse(call: DisburseCall): Promise<DisburseOutcome>;
}

/** Bearer tokens for capacity, one per tenant (ADR 024). */
export interface TenantTokens {
  tokenFor(tenantId: string): Promise<string>;
  /** After an UNAUTHENTICATED answer the cached token is not trusted again. */
  invalidate(tenantId: string): void;
}

/** What the metrics read from the database on each scrape (ADR 025, observability). */
export interface SagaStats {
  readonly counts: ReadonlyMap<string, number>;
  /** Age of the oldest request per non-terminal state, in seconds. */
  readonly oldestAgeSeconds: ReadonlyMap<string, number>;
  /** Oldest COMPENSATING request whose reservation is still unknown, 0 when none. */
  readonly oldestUnresolvedReserveAgeSeconds: number;
}

export interface SagaStatsSource {
  stats(): Promise<SagaStats>;
  /** Cheap round trip plus "the newest migration is recorded". */
  ping(): Promise<void>;
}
