import { formatMoney } from '#src/capacity/domain/index.js';
import type { IdGenerator, TreasuryScope, TreasuryUnitOfWork } from '../../ports/index.js';
import { fingerprintOf } from '../../shared/fingerprint.js';
import { releaseCapacity } from '../../shared/release-capacity.js';
import {
  PermanentError,
  type MessageSource,
  type TreasuryLogger,
  type TreasuryResult,
} from '../../shared/treasury-errors.js';
import {
  moneyOf,
  type ProgramLimitSet,
  type RepaymentReceived,
} from '../../shared/treasury-messages.js';
import { capacityView } from '../../shared/views.js';

export interface ApplyTreasuryEventDeps {
  readonly uow: TreasuryUnitOfWork;
  readonly ids: IdGenerator;
  readonly logger: TreasuryLogger;
}

const ACTOR = 'treasury';

/**
 * Treasury limit changes and repayments (PRD §8, CP-3): inbox row, then program lock, then the
 * change; the sequence check makes a stale or reordered message a logged no-op (FR-09).
 */
export class ApplyTreasuryEvent {
  constructor(private readonly deps: ApplyTreasuryEventDeps) {}

  async execute(
    source: MessageSource,
    message: ProgramLimitSet | RepaymentReceived,
  ): Promise<TreasuryResult> {
    const result = await this.deps.uow.run((tx) =>
      message.type === 'ProgramLimitSet'
        ? this.setLimit(tx, source, message)
        : this.repay(tx, source, message),
    );
    if (result.status !== 'applied') {
      this.deps.logger.info(
        {
          event: result.status === 'stale' ? 'stale-skipped' : 'duplicate-skipped',
          messageId: message.messageId,
          type: message.type,
          seq: message.seq,
          treasurySeq: result.status === 'stale' ? result.treasurySeq : undefined,
          programId: message.programId,
          topic: source.topic,
        },
        result.status === 'stale' ? 'stale treasury message skipped' : 'duplicate message skipped',
      );
    }
    return result;
  }

  private async setLimit(
    tx: TreasuryScope,
    source: MessageSource,
    message: ProgramLimitSet,
  ): Promise<TreasuryResult> {
    const { tenantId, programId, seq, messageId } = message;
    if (!(await tx.inbox.claim(source, messageId))) return { status: 'duplicate' };
    const limit = moneyOf(message.payload.creditLimit);
    // Program ids are unique per tenant only, keyed (tenant_id, id) (AC-16, ADR 011).
    await tx.treasuryPrograms.createIfMissing({
      tenantId,
      id: programId,
      currency: limit.currency,
    });
    const program = await tx.programs.lockForUpdate(tenantId, programId);
    if (program === null) throw new Error('program vanished right after it was created');
    if (program.currency !== limit.currency) {
      throw new PermanentError(
        'currency-mismatch',
        `program ${programId} is ${program.currency}, the limit is ${limit.currency}`,
      );
    }
    if (seq <= program.treasurySeq) return { status: 'stale', treasurySeq: program.treasurySeq };

    const updated = await tx.treasuryPrograms.applyChange(tenantId, programId, {
      creditLimitMinor: limit.minor,
      status: message.payload.status,
      treasurySeq: seq,
    });
    await tx.ledger.append({
      tenantId,
      programId,
      reservationId: null,
      kind: 'LIMIT_SET',
      deltaReservedMinor: 0n,
      deltaLimitMinor: limit.minor - program.creditLimitMinor,
      limitAfter: updated.creditLimitMinor,
      reservedAfter: updated.reservedMinor,
      causeType: 'kafka',
      causeId: messageId,
      actor: ACTOR,
    });
    await tx.outbox.append({
      tenantId,
      programId,
      programSeq: updated.platformSeq,
      type: 'ProgramCapacityChanged',
      payload: {
        tenantId,
        programId,
        programSeq: updated.platformSeq,
        cause: 'limit-set',
        capacity: capacityView(updated),
      },
    });
    return { status: 'applied' };
  }

  /** A repayment is a release through the shared FR-03 path, keyed by treasury's reference. */
  private async repay(
    tx: TreasuryScope,
    source: MessageSource,
    message: RepaymentReceived,
  ): Promise<TreasuryResult> {
    const { tenantId, programId, seq, messageId } = message;
    const { invoiceId, releaseRef } = message.payload;
    if (!(await tx.inbox.claim(source, messageId))) return { status: 'duplicate' };

    // A stale repayment is skipped before anything else is asked of it (FR-09). This read takes
    // no lock; the authoritative check repeats under the program lock inside the release path.
    const known = await tx.treasuryPrograms.find(tenantId, programId);
    if (known === null) throw new PermanentError('unknown-program', `${tenantId}:${programId}`);
    if (seq <= known.treasurySeq) return { status: 'stale', treasurySeq: known.treasurySeq };

    // A plain read: the release path claims its release_ref before it locks the program.
    const reservation = await tx.reservations.findByInvoice(tenantId, programId, invoiceId);
    if (reservation === null) {
      throw new PermanentError(
        'unknown-reservation',
        `no reservation for invoice ${invoiceId} in ${tenantId}:${programId}`,
      );
    }
    const amount = moneyOf(message.payload.amount);
    if (amount.currency !== reservation.invoiceAmount.currency) {
      throw new PermanentError(
        'release-rejected',
        `repayment is in ${amount.currency}, the invoice is ${reservation.invoiceAmount.currency}`,
      );
    }
    let stale = 0;
    const outcome = await releaseCapacity(tx, this.deps.ids, {
      tenantId,
      programId,
      reservationId: reservation.id,
      releaseRef,
      reason: 'REPAID',
      amount,
      fingerprint: fingerprintOf({
        reason: 'REPAID',
        amount: { value: formatMoney(amount), currency: amount.currency },
      }),
      cause: { type: 'kafka', id: messageId, actor: ACTOR },
      proceedWith: (program) => {
        if (seq <= program.treasurySeq) {
          stale = program.treasurySeq;
          return false;
        }
        return true;
      },
    });
    if (outcome === null) return { status: 'stale', treasurySeq: stale };
    if (!outcome.ok) {
      throw new PermanentError(
        'release-rejected',
        `${outcome.problem.type}: ${outcome.problem.detail}`,
      );
    }
    await tx.treasuryPrograms.markTreasurySeq(tenantId, programId, seq);
    return { status: 'applied' };
  }
}
