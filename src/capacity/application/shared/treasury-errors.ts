/** Why a treasury message can never succeed; the consumer parks it in the DLQ (PRD §8, step 5). */
export type PermanentCode =
  | 'schema-invalid'
  | 'unknown-program'
  | 'unknown-reservation'
  | 'tenant-mismatch'
  | 'currency-mismatch'
  | 'release-rejected'
  | 'snapshot-too-large'
  | 'invalid-snapshot'
  | 'database-constraint';

export class PermanentError extends Error {
  constructor(
    readonly code: PermanentCode,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

/** What a consumer needs to say about one message in its logs. */
export interface TreasuryLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Where a message came from; recorded in the inbox row. */
export interface MessageSource {
  /** Inbox consumer name, one per topic. */
  readonly consumer: string;
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;
}

export type TreasuryResult =
  | { readonly status: 'applied' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'stale'; readonly treasurySeq: number };
