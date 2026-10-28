# 013. OpenTelemetry instead of `@nestjs/observe`

- Status: accepted
- Date: 2026-10-28

## Context

NFR-10 asks for JSON logs with a trace id, RED and domain metrics, traces across HTTP, PostgreSQL
and Kafka, and a dashboard and alert rules as code. The service sits inside a platform whose other
services are not necessarily NestJS.

## Decision

- Traces: the OpenTelemetry Node SDK started before the application when `OTEL_ENABLED=true`
  (HTTP, Express and `pg` instrumentations, OTLP/HTTP exporter to the collector or Jaeger).
  Off by default: no exporter, no overhead.
- Logs: pino JSON; a mixin adds `trace_id` and `span_id` of the active span to every line.
- Metrics: Prometheus format on the internal ops port (`prom-client`); domain gauges
  (`outbox_lag`, `invariant_mismatch_programs`, over-limit programs, DLQ and consumer lag).
- Dashboards and alert rules are files in `deploy/observability/`, started by the compose
  `observability` profile (Prometheus, Grafana, Jaeger).

## Consequences

- Vendor-neutral: production ships the same signals through the ADOT collector to CloudWatch and
  X-Ray with a configuration change.
- Correlation works across services because the W3C trace context is the standard one.
- Instrumentation hooks need the SDK to load before the libraries it patches, so the telemetry
  module is the first import of `main.ts`.

## Alternatives rejected

`@nestjs/observe` (NestJS-only, no cross-stack correlation); CloudWatch or X-Ray SDKs locally
(needs an account, NFR-12); logging a hand-made correlation id only (no spans, no PostgreSQL
timing).
