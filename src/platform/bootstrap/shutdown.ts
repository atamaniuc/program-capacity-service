import type { Logger } from '../logging/logger.js';

/** NFR-07: the whole shutdown (intake, in-flight work, pool) must finish within 25 s. */
export const SHUTDOWN_DEADLINE_MS = 25_000;

/** Closes the app, failing when it does not finish before the deadline. */
export async function closeWithin(
  app: { close(): Promise<void> },
  logger: Logger,
  deadlineMs: number = SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`shutdown exceeded ${deadlineMs} ms`));
    }, deadlineMs);
  });
  try {
    await Promise.race([app.close(), deadline]);
    logger.info({ elapsedMs: Date.now() - started }, 'shutdown complete');
  } finally {
    clearTimeout(timer);
  }
}
