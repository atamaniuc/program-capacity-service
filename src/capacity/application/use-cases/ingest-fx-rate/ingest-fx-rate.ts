import { parseFxRate } from '#src/capacity/domain/index.js';
import type { TreasuryUnitOfWork } from '../../ports/index.js';
import {
  PermanentError,
  type MessageSource,
  type TreasuryLogger,
  type TreasuryResult,
} from '../../shared/treasury-errors.js';
import { assertSupportedCurrency, type FxRatePublished } from '../../shared/treasury-messages.js';

export interface IngestFxRateDeps {
  readonly uow: TreasuryUnitOfWork;
  readonly logger: TreasuryLogger;
}

/**
 * Treasury FX rates (FR-08). A rate has no program, so there is no program lock: the inbox row
 * deduplicates the message and the insert keeps every (pair, as_of); the reserve path reads the
 * newest `as_of` within FX_MAX_AGE, so an older rate arriving late never wins.
 */
export class IngestFxRate {
  constructor(private readonly deps: IngestFxRateDeps) {}

  async execute(source: MessageSource, message: FxRatePublished): Promise<TreasuryResult> {
    const { base, quote, rate, asOf, source: rateSource } = message.payload;
    assertSupportedCurrency(base);
    assertSupportedCurrency(quote);
    const parsed = parseFxRate(rate);
    if (!parsed.ok) throw new PermanentError('schema-invalid', `rate ${rate} is invalid`);
    const result = await this.deps.uow.run(async (tx): Promise<TreasuryResult> => {
      if (!(await tx.inbox.claim(source, message.messageId))) return { status: 'duplicate' };
      await tx.fxWriter.upsert({
        base,
        quote,
        rate: parsed.value,
        source: rateSource,
        asOf: new Date(asOf),
      });
      return { status: 'applied' };
    });
    if (result.status === 'duplicate') {
      this.deps.logger.info(
        { event: 'duplicate-skipped', messageId: message.messageId, topic: source.topic },
        'duplicate fx rate skipped',
      );
    }
    return result;
  }
}
