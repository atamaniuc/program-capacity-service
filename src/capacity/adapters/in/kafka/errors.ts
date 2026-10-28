import { ZodError } from 'zod';
import { PermanentError } from '#src/capacity/application/shared/treasury-errors.js';

export type FailureKind = 'permanent' | 'transient';

export interface Failure {
  readonly kind: FailureKind;
  readonly code: string;
  readonly message: string;
}

/** PostgreSQL SQLSTATE classes whose retry can never succeed: data exception, integrity violation. */
const PERMANENT_SQLSTATE_CLASSES = ['22', '23'];

/**
 * Permanent: the message itself is wrong, so it goes to the DLQ and the partition moves on.
 * Transient: the environment is wrong (database down, lock timeout, deadlock), so the partition
 * waits and the same message is retried; nothing is committed.
 */
export function classify(error: unknown): Failure {
  if (error instanceof PermanentError) {
    return { kind: 'permanent', code: error.code, message: error.message };
  }
  if (error instanceof ZodError) {
    return {
      kind: 'permanent',
      code: 'schema-invalid',
      message: error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }
  const sqlState = (error as { code?: unknown } | null)?.code;
  if (
    typeof sqlState === 'string' &&
    PERMANENT_SQLSTATE_CLASSES.some((prefix) => sqlState.startsWith(prefix)) &&
    /^[0-9A-Z]{5}$/.test(sqlState)
  ) {
    return {
      kind: 'permanent',
      code: 'database-constraint',
      message: `${sqlState}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    kind: 'transient',
    code: 'transient',
    message: error instanceof Error ? error.message : String(error),
  };
}
