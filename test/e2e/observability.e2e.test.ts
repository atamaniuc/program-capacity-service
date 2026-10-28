import { Writable } from 'node:stream';
import { SpanKind, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import pino from 'pino';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '#src/platform/telemetry/otel.js';
import { traceContextMixin } from '#src/platform/telemetry/trace-context.js';
import type { TestApp } from '../support/app.js';

describe('observability', () => {
  const exporter = new InMemorySpanExporter();
  let telemetry: Telemetry;
  let app: TestApp;

  beforeAll(async () => {
    // The SDK must start before the app loads http, express and pg, so the app is imported late.
    telemetry = startTelemetry({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    const { startTestApp } = await import('../support/app.js');
    app = await startTestApp();
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
              VALUES ('bank-a', 'prg-trace', 'USD', 1000000000)`.execute(app.persistence.db);
  });

  afterAll(async () => {
    await app.stop();
    await telemetry.shutdown();
  });

  it('NFR-10 a reservation produces one trace that spans HTTP and PostgreSQL', async () => {
    exporter.reset();
    const created = await app.request('POST', '/v1/programs/prg-trace/reservations', {
      body: { invoiceId: 'INV-TRACE', amount: { value: '10.00', currency: 'USD' } },
    });
    expect(created.status).toBe(201);

    const spans = exporter.getFinishedSpans();
    const server = spans.find(
      (span) =>
        span.kind === SpanKind.SERVER &&
        JSON.stringify(span.attributes).includes('/v1/programs/prg-trace/reservations'),
    );
    expect(server, 'an HTTP server span for the reservation').toBeDefined();
    const sameTrace = spans.filter(
      (span) => span.spanContext().traceId === server?.spanContext().traceId,
    );
    const database = sameTrace.filter((span) =>
      JSON.stringify(span.attributes).includes('postgres'),
    );
    expect(database.length).toBeGreaterThan(0);
  });

  it('NFR-10 log lines written inside a span carry its trace_id and span_id', () => {
    const lines: Record<string, unknown>[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        callback();
      },
    });
    const logger = pino({ mixin: traceContextMixin }, sink);

    logger.info('outside any span');
    trace.getTracer('test').startActiveSpan('work', (span) => {
      logger.info('inside a span');
      expect(lines[1]).toMatchObject({
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
        msg: 'inside a span',
      });
      span.end();
    });
    expect(lines[0]).not.toHaveProperty('trace_id');
  });

  it('NFR-10 the ops port exports RED metrics for the business API', async () => {
    await app.request('GET', '/v1/programs/prg-trace/capacity');
    const metrics = await (await fetch(`${app.opsUrl}/metrics`)).text();
    expect(metrics).toMatch(
      /http_requests_total\{method="GET",route="\/v1\/programs\/:programId\/capacity",status="200"\} 1/,
    );
    expect(metrics).toContain('http_request_duration_seconds_bucket');
  });
});
