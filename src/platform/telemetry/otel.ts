import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';

export interface TelemetryOptions {
  readonly serviceName?: string;
  /** Replaces the OTLP exporter, e.g. an in-memory exporter in tests. */
  readonly spanProcessors?: NodeSDKConfiguration['spanProcessors'];
}

export interface Telemetry {
  /** Flushes pending spans and stops the SDK. */
  shutdown(): Promise<void>;
}

/** Paths of the ops port: probes and scrapes would drown the traces that matter. */
const OPS_PATH = /^\/(health|metrics|docs)/;

/**
 * NFR-10: traces across HTTP, Express and PostgreSQL. Must run before the libraries it patches
 * are loaded, so `main.ts` imports `register.ts` first. The OTLP/HTTP exporter reads the
 * standard `OTEL_EXPORTER_OTLP_ENDPOINT` variable.
 */
export function startTelemetry(options: TelemetryOptions = {}): Telemetry {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? 'program-capacity',
    }),
    ...(options.spanProcessors === undefined
      ? { traceExporter: new OTLPTraceExporter() }
      : { spanProcessors: options.spanProcessors }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => OPS_PATH.test(request.url ?? ''),
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
