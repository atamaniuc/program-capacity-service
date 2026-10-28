import { migrate } from '#src/capacity/adapters/out/postgres/migrate.js';
import { startApp, type RunningApp } from '#src/platform/bootstrap/start.js';
import { loadConfig, type AppRole } from '#src/platform/config/config.js';
import { createLogger } from '#src/platform/logging/logger.js';
import { loadRuntimeSettings } from '#src/platform/telemetry/settings.js';
import { freePort } from './app.js';
import { startTestIssuer, type TestIssuer } from './auth.js';

export interface FaultApp {
  readonly app: RunningApp;
  readonly baseUrl: string;
  readonly opsUrl: string;
  readonly issuer: TestIssuer;
  token(): Promise<string>;
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
  ready(): Promise<{ status: number; body: unknown }>;
  stopIssuer(): Promise<void>;
}

/** The real app (api, worker or all) against a database URL and optional Kafka brokers. */
export async function startFaultApp(options: {
  databaseUrl: string;
  role: AppRole;
  kafkaBrokers?: string;
  env?: Record<string, string>;
  migrateFirst?: boolean;
}): Promise<FaultApp> {
  if (options.migrateFirst !== false) await migrate(options.databaseUrl);
  const issuer = await startTestIssuer();
  const httpPort = await freePort();
  const env = {
    APP_ROLE: options.role,
    HTTP_PORT: String(httpPort),
    OPS_PORT: String(await freePort()),
    DATABASE_URL: options.databaseUrl,
    KAFKA_BROKERS: options.kafkaBrokers ?? '127.0.0.1:1',
    OAUTH_ISSUER: issuer.issuer,
    OAUTH_AUDIENCE: issuer.audience,
    OAUTH_JWKS_URL: issuer.jwksUrl,
    LOG_LEVEL: 'silent',
    ...options.env,
  };
  const app = await startApp(
    loadConfig(env),
    createLogger('silent'),
    loadRuntimeSettings({ OUTBOX_POLL_INTERVAL_MS: '200', ...options.env }),
  );
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const opsUrl = `http://127.0.0.1:${app.opsPort}`;
  const token = (): Promise<string> =>
    issuer.sign({ tenantId: 'bank-a', scope: 'capacity:read capacity:write', sub: 'svc-orders' });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };

  return {
    app,
    baseUrl,
    opsUrl,
    issuer,
    token,
    get: (path) => call('GET', path),
    post: (path, body, headers) => call('POST', path, body, headers),
    ready: async () => {
      const response = await fetch(`${opsUrl}/health/ready`);
      return { status: response.status, body: await response.json() };
    },
    stopIssuer: () => issuer.close(),
  };
}

export async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
