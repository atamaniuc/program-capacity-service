import type { RequestHandler } from 'express';
import { Counter, Histogram, type Registry } from 'prom-client';

/**
 * RED metrics of the business API (NFR-10): request rate and errors by route and status class,
 * duration histogram. The route label is the Express route pattern, never the raw URL, so
 * cardinality stays bounded; unmatched paths share one label.
 */
export function httpMetrics(registry: Registry): RequestHandler {
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of business API requests.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const requests = new Counter({
    name: 'http_requests_total',
    help: 'Business API requests by route and status.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  return (request, response, next) => {
    const started = process.hrtime.bigint();
    response.once('finish', () => {
      const route = (request.route as { path?: string } | undefined)?.path;
      const labels = {
        method: request.method,
        route: route ?? 'unmatched',
        status: String(response.statusCode),
      };
      duration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
      requests.inc(labels);
    });
    next();
  };
}
