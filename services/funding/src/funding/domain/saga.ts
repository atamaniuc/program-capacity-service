import { type SagaConfig, backoffDelayMs } from './config.js';
import { type FundingRequest, isTerminal } from './funding-request.js';
import { compensationRef, stepKey } from './keys.js';
import type { DisburseOutcome, ReleaseOutcome, ReserveOutcome } from './outcome.js';
import type { RiskDecision } from './risk.js';
import { err, ok, type Result } from './result.js';

/** The call the driver must make next, with the key every attempt of it carries. */
export type Command =
  | { readonly step: 'risk' }
  | { readonly step: 'reserve'; readonly key: string; readonly resolving: boolean }
  | {
      readonly step: 'disburse';
      readonly key: string;
      /** After an unknown attempt the next one first asks the rail for the payment by key. */
      readonly lookupFirst: boolean;
    }
  | {
      readonly step: 'release';
      readonly key: string;
      readonly releaseRef: string;
      readonly reservationId: string;
      readonly reason: 'CANCELLED';
    };

/** What happened to the command; the matching `step` is checked against the request's state. */
export type StepOutcome =
  | { readonly step: 'risk'; readonly decision: RiskDecision }
  | { readonly step: 'reserve'; readonly outcome: ReserveOutcome }
  | { readonly step: 'disburse'; readonly outcome: DisburseOutcome }
  | { readonly step: 'release'; readonly outcome: ReleaseOutcome };

export type OutboxEventType =
  | 'FundingRequestCompleted'
  | 'FundingRequestRejected'
  | 'FundingRequestFailed'
  | 'FundingRequestNeedsAttention';

export type AttemptClass = 'success' | 'failure' | 'unknown';

export interface Transition {
  readonly request: FundingRequest;
  /** Inserted into the outbox in the same transaction as the new state. */
  readonly event?: OutboxEventType;
  /** An operator is paged (FundingNeedsAttention). */
  readonly alert: boolean;
  /** The row for the append-only attempt log. */
  readonly attempt: {
    readonly step: Command['step'];
    readonly class: AttemptClass;
    readonly key?: string;
  };
}

export type TransitionError = 'terminal' | 'awaiting-operator' | 'step-mismatch';

export interface TransitionContext {
  /** Database time, epoch milliseconds. */
  readonly now: number;
  readonly config: SagaConfig;
  /** A value in [0, 1) for the backoff jitter. */
  readonly random: number;
}

/** The step to run for a request, or `undefined` while no step is due (terminal, parked). */
export function nextCommand(request: FundingRequest): Command | undefined {
  switch (request.state) {
    case 'RECEIVED':
      return { step: 'risk' };
    case 'RESERVING':
      return { step: 'reserve', key: stepKey(request.id, 'reserve'), resolving: false };
    case 'DISBURSING':
      return {
        step: 'disburse',
        key: stepKey(request.id, 'disburse'),
        lookupFirst: request.attempts > 0,
      };
    case 'COMPENSATING':
      return request.reservationId === undefined
        ? { step: 'reserve', key: stepKey(request.id, 'reserve'), resolving: true }
        : {
            step: 'release',
            key: stepKey(request.id, 'release'),
            releaseRef: compensationRef(request.id),
            reservationId: request.reservationId,
            reason: 'CANCELLED',
          };
    default:
      return undefined;
  }
}

/** A state change: the step's counters restart and the next step is due at once. */
function moveTo(
  request: FundingRequest,
  patch: Partial<FundingRequest> & Pick<FundingRequest, 'state'>,
  now: number,
): FundingRequest {
  return { ...request, ...patch, attempts: 0, nextAttemptAt: now };
}

/** Same state, one more unknown outcome: due again after the backoff. */
function retry(request: FundingRequest, ctx: TransitionContext): FundingRequest {
  return {
    ...request,
    attempts: request.attempts + 1,
    nextAttemptAt: ctx.now + backoffDelayMs(request.attempts, ctx.random),
  };
}

function attemptOf(command: Command, klass: AttemptClass): Transition['attempt'] {
  return command.step === 'risk'
    ? { step: 'risk', class: klass }
    : { step: command.step, class: klass, key: command.key };
}

/**
 * The transition table of ADR 025 as a pure function. Returns the new request and what must
 * commit with it; refuses outcomes for a terminal or parked request and outcomes of a step
 * that is not the one due (a stale executor records nothing).
 */
export function applyOutcome(
  request: FundingRequest,
  outcome: StepOutcome,
  ctx: TransitionContext,
): Result<Transition, TransitionError> {
  if (isTerminal(request.state)) return err('terminal');
  const command = nextCommand(request);
  if (command === undefined) return err('awaiting-operator');
  if (command.step !== outcome.step) return err('step-mismatch');
  const { now, config } = ctx;
  const done = (
    next: FundingRequest,
    klass: AttemptClass,
    extra: { event?: OutboxEventType; alert?: boolean } = {},
  ): Result<Transition, TransitionError> =>
    ok({
      request: next,
      ...(extra.event === undefined ? {} : { event: extra.event }),
      alert: extra.alert ?? false,
      attempt: attemptOf(command, klass),
    });

  switch (outcome.step) {
    case 'risk': {
      if (outcome.decision.approved) {
        return done(
          moveTo(
            request,
            { state: 'RESERVING', reserveDeadlineAt: now + config.reserveDeadlineMs },
            now,
          ),
          'success',
        );
      }
      return done(
        moveTo(request, { state: 'REJECTED', reason: outcome.decision.reason }, now),
        'failure',
        { event: 'FundingRequestRejected' },
      );
    }

    case 'reserve': {
      const result = outcome.outcome;
      if (request.state === 'RESERVING') {
        switch (result.kind) {
          case 'created':
            return done(
              moveTo(
                request,
                {
                  state: 'DISBURSING',
                  reservationId: result.reservationId,
                  disburseDeadlineAt: now + config.disburseDeadlineMs,
                },
                now,
              ),
              'success',
            );
          case 'existing':
            return done(
              moveTo(request, { state: 'REJECTED', reason: 'invoice-already-reserved' }, now),
              'failure',
              { event: 'FundingRequestRejected' },
            );
          case 'failure':
            return done(
              moveTo(request, { state: 'REJECTED', reason: result.problem }, now),
              'failure',
              { event: 'FundingRequestRejected' },
            );
          case 'unknown':
            if (request.reserveDeadlineAt !== undefined && now >= request.reserveDeadlineAt) {
              return done(
                moveTo(
                  request,
                  {
                    state: 'COMPENSATING',
                    reason: 'reserve-unresolved',
                    resolutionDeadlineAt: now + config.reserveResolutionLimitMs,
                  },
                  now,
                ),
                'unknown',
              );
            }
            return done(retry(request, ctx), 'unknown');
        }
      }
      // COMPENSATING with the reservation unknown: Reserve repeated under the same key.
      switch (result.kind) {
        case 'created':
          return done(
            moveTo(request, { state: 'COMPENSATING', reservationId: result.reservationId }, now),
            'success',
          );
        case 'existing':
        case 'failure':
          return done(moveTo(request, { state: 'FAILED' }, now), 'failure', {
            event: 'FundingRequestFailed',
          });
        case 'unknown':
          if (request.resolutionDeadlineAt !== undefined && now >= request.resolutionDeadlineAt) {
            return done(
              moveTo(request, { state: 'NEEDS_ATTENTION', reason: 'reserve-unresolved' }, now),
              'unknown',
              { event: 'FundingRequestNeedsAttention', alert: true },
            );
          }
          return done(retry(request, ctx), 'unknown');
      }
      break;
    }

    case 'disburse': {
      const result = outcome.outcome;
      switch (result.kind) {
        case 'paid':
          return done(
            moveTo(request, { state: 'COMPLETED', paymentId: result.paymentId }, now),
            'success',
            { event: 'FundingRequestCompleted' },
          );
        case 'declined':
          return done(
            moveTo(request, { state: 'COMPENSATING', reason: 'payment-declined' }, now),
            'failure',
          );
        case 'unknown':
          // Never compensate: the money may have left (ADR 025).
          if (request.disburseDeadlineAt !== undefined && now >= request.disburseDeadlineAt) {
            return done(
              moveTo(request, { state: 'NEEDS_ATTENTION', reason: 'disbursement-unknown' }, now),
              'unknown',
              { event: 'FundingRequestNeedsAttention', alert: true },
            );
          }
          return done(retry(request, ctx), 'unknown');
      }
      break;
    }

    case 'release': {
      const result = outcome.outcome;
      switch (result.kind) {
        case 'released':
          return done(moveTo(request, { state: 'FAILED' }, now), 'success', {
            event: 'FundingRequestFailed',
          });
        case 'failure':
          return done(
            moveTo(
              request,
              { state: 'NEEDS_ATTENTION', reason: `release-failed:${result.problem}` },
              now,
            ),
            'failure',
            { event: 'FundingRequestNeedsAttention', alert: true },
          );
        case 'unknown':
          // Retries forever: release_ref never expires (ADR 025).
          return done(retry(request, ctx), 'unknown');
      }
      break;
    }
  }
  return err('step-mismatch');
}
