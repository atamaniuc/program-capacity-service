import { startTelemetry, type Telemetry } from './otel.js';

/**
 * Side-effect module: import it before anything that loads `http`, `express` or `pg`.
 * With `OTEL_ENABLED=true` the SDK starts here; otherwise nothing is loaded or patched.
 */
const telemetry: Telemetry | null =
  process.env['OTEL_ENABLED'] === 'true' ? startTelemetry() : null;

/** Flushes spans on shutdown; a no-op when telemetry is off. */
export async function shutdownTelemetry(): Promise<void> {
  await telemetry?.shutdown();
}
