import type { ApplyTreasuryEvent } from '#src/capacity/application/use-cases/apply-treasury-event/apply-treasury-event.js';
import type { IngestFxRate } from '#src/capacity/application/use-cases/ingest-fx-rate/ingest-fx-rate.js';
import type { ReconcileProgram } from '#src/capacity/application/use-cases/reconcile-program/reconcile-program.js';
import {
  PermanentError,
  type MessageSource,
} from '#src/capacity/application/shared/treasury-errors.js';
import {
  fxRatePublishedSchema,
  messageKey,
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
  treasuryCapacityMessageSchema,
} from '#src/capacity/application/shared/treasury-messages.js';

/** What the runner hands over for one Kafka record. */
export interface RawMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
}

export interface MessageHandler {
  handle(raw: RawMessage): Promise<void>;
}

export interface TreasuryHandlerDeps {
  readonly apply: ApplyTreasuryEvent;
  readonly reconcile: ReconcileProgram;
  readonly ingestFx: IngestFxRate;
}

const CONSUMER_BY_TOPIC: Readonly<Record<string, string>> = {
  [TOPIC_CAPACITY]: 'treasury-capacity',
  [TOPIC_FX_RATES]: 'treasury-fx',
};

/**
 * Treasury ACL: decodes, validates and routes one record to its use case. Anything that makes
 * the record itself unusable is a PermanentError; infrastructure errors pass through untouched.
 */
export class TreasuryMessageHandler implements MessageHandler {
  constructor(private readonly deps: TreasuryHandlerDeps) {}

  async handle(raw: RawMessage): Promise<void> {
    const consumer = CONSUMER_BY_TOPIC[raw.topic];
    if (consumer === undefined)
      throw new PermanentError('schema-invalid', `unexpected topic ${raw.topic}`);
    const source: MessageSource = {
      consumer,
      topic: raw.topic,
      partition: raw.partition,
      offset: raw.offset,
    };
    const json = decode(raw.value);

    if (raw.topic === TOPIC_FX_RATES) {
      await this.deps.ingestFx.execute(source, fxRatePublishedSchema.parse(json));
      return;
    }
    const message = treasuryCapacityMessageSchema.parse(json);
    // The key carries per-program order; a record whose key names another tenant or program
    // could be applied to the wrong program, so it is refused (PRD §9).
    const key = raw.key?.toString('utf8') ?? null;
    if (key !== messageKey(message.tenantId, message.programId)) {
      throw new PermanentError(
        'tenant-mismatch',
        `key ${key ?? '(none)'} does not match ${messageKey(message.tenantId, message.programId)}`,
      );
    }
    if (message.type === 'ProgramReconciled') {
      await this.deps.reconcile.execute(source, message);
    } else {
      await this.deps.apply.execute(source, message);
    }
  }
}

function decode(value: Buffer | null): unknown {
  if (value === null) throw new PermanentError('schema-invalid', 'message has no value');
  try {
    return JSON.parse(value.toString('utf8')) as unknown;
  } catch {
    throw new PermanentError('schema-invalid', 'message value is not valid JSON');
  }
}
