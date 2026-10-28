import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry, collectDefaultMetrics } from 'prom-client';

/** One named dependency check; later lanes add the Kafka consumer state here. */
export type ReadinessCheck = () => Promise<void>;

export interface OpsServerOptions {
  readonly port: number;
  readonly checks: Readonly<Record<string, ReadinessCheck>>;
  readonly registry?: Registry;
}

export interface OpsServer {
  readonly registry: Registry;
  /** Flips /health/ready to 503 so the load balancer drains before the process stops. */
  markDraining(): void;
  port(): number;
  close(): Promise<void>;
}

/** Internal HTTP server for probes and Prometheus; never exposed on the business port (A8). */
export async function startOpsServer(options: OpsServerOptions): Promise<OpsServer> {
  const registry = options.registry ?? new Registry();
  collectDefaultMetrics({ register: registry });
  let draining = false;

  const server: Server = createServer((request, response) => {
    const send = (status: number, contentType: string, body: string): void => {
      response.writeHead(status, { 'content-type': contentType });
      response.end(body);
    };
    const sendJson = (status: number, body: unknown): void => {
      send(status, 'application/json', JSON.stringify(body));
    };
    const route = async (): Promise<void> => {
      if (request.method !== 'GET') {
        sendJson(405, { status: 'method not allowed' });
        return;
      }
      const path = (request.url ?? '/').split('?')[0];
      if (path === '/health/live') {
        sendJson(200, { status: 'up' });
      } else if (path === '/health/ready') {
        const report: Record<string, 'up' | 'down'> = {};
        for (const [name, check] of Object.entries(options.checks)) {
          report[name] = await check().then(
            () => 'up' as const,
            () => 'down' as const,
          );
        }
        const healthy = !draining && Object.values(report).every((state) => state === 'up');
        sendJson(healthy ? 200 : 503, { status: healthy ? 'up' : 'down', ...report });
      } else if (path === '/metrics') {
        send(200, registry.contentType, await registry.metrics());
      } else {
        sendJson(404, { status: 'not found' });
      }
    };
    route().catch(() => {
      sendJson(500, { status: 'error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', resolve);
  });

  return {
    registry,
    markDraining: () => {
      draining = true;
    },
    port: () => (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
