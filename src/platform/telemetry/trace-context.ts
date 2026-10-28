import { trace } from '@opentelemetry/api';

/** pino mixin: puts the active span's ids on every log line so logs and traces correlate. */
export function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}
