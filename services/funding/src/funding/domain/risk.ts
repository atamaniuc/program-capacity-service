import { currencyScale, type Money } from './money.js';

/** Per-currency limit on one invoice amount, in minor units. */
export interface RiskPolicy {
  readonly limits: Readonly<Record<string, bigint>>;
}

export type RiskDecision =
  { readonly approved: true } | { readonly approved: false; readonly reason: 'risk-declined' };

/**
 * Local, deterministic and effect-free (ADR 025 step 1). An amount above the limit of its
 * currency, or in a currency with no limit, is declined.
 */
export function assessRisk(amount: Money, policy: RiskPolicy): RiskDecision {
  const limit =
    currencyScale(amount.currency) !== undefined && Object.hasOwn(policy.limits, amount.currency)
      ? policy.limits[amount.currency]
      : undefined;
  if (limit === undefined || amount.minor > limit)
    return { approved: false, reason: 'risk-declined' };
  return { approved: true };
}
