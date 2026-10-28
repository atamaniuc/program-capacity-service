import { createServer } from 'node:net';
import { createPersistence, type Persistence } from '#src/capacity/adapters/out/postgres/db.js';
import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { startApp, type RunningApp } from '#src/platform/bootstrap/start.js';
import { loadConfig } from '#src/platform/config/config.js';
import { createLogger } from '#src/platform/logging/logger.js';
import { startTestIssuer, type TestIssuer, type TokenClaims } from './auth.js';
import { startPostgres, type TestPostgres } from './postgres.js';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

export interface TestApp {
  readonly baseUrl: string;
  readonly opsUrl: string;
  readonly persistence: Persistence;
  readonly issuer: TestIssuer;
  /** A valid bearer token; defaults to tenant `bank-a` with both scopes. */
  token(claims?: TokenClaims): Promise<string>;
  request(
    method: string,
    path: string,
    options?: {
      token?: string | null;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: string;
    },
  ): Promise<{ status: number; headers: Headers; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  stop(): Promise<void>;
}

/** The Nest app against Testcontainers PostgreSQL 18 and an in-process JWKS issuer. */
export async function startTestApp(): Promise<TestApp> {
  const postgres: TestPostgres = await startPostgres();
  await migrate(postgres.url);
  const issuer = await startTestIssuer();
  const httpPort = await freePort();
  const config = loadConfig({
    APP_ROLE: 'api',
    HTTP_PORT: String(httpPort),
    OPS_PORT: String(await freePort()),
    DATABASE_URL: postgres.url,
    KAFKA_BROKERS: 'localhost:9092',
    OAUTH_ISSUER: issuer.issuer,
    OAUTH_AUDIENCE: issuer.audience,
    OAUTH_JWKS_URL: issuer.jwksUrl,
    LOG_LEVEL: 'silent',
  });
  const app: RunningApp = await startApp(config, createLogger('silent'));
  const persistence = createPersistence(postgres.url, 5);
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  const token = (claims: TokenClaims = {}): Promise<string> =>
    issuer.sign({
      tenantId: 'bank-a',
      scope: 'capacity:read capacity:write',
      sub: 'svc-orders',
      ...claims,
    });

  return {
    baseUrl,
    opsUrl: `http://127.0.0.1:${app.opsPort}`,
    persistence,
    issuer,
    token,
    request: async (method, path, options = {}) => {
      const headers: Record<string, string> = { ...options.headers };
      const bearer = options.token === undefined ? await token() : options.token;
      if (bearer !== null) headers['authorization'] = `Bearer ${bearer}`;
      let body: string | undefined;
      if (options.rawBody !== undefined) {
        body = options.rawBody;
        headers['content-type'] = 'application/json';
      } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers['content-type'] = 'application/json';
      }
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, headers: response.headers, body: parsed };
    },
    stop: async () => {
      await app.close();
      await persistence.close();
      await issuer.close();
      await postgres.stop();
    },
  };
}
