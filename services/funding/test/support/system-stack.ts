import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { credentials, Metadata, status, type ServiceError } from '@grpc/grpc-js';
import { CapacityServiceClient, ReleaseReason } from '@finverity/contracts/capacity/v1';
import pg from 'pg';
import { ToxiProxyContainer, type CreatedProxy } from '@testcontainers/toxiproxy';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import {
  errorReasonOf,
  GrpcCapacityGateway,
} from '#src/funding/adapters/out/grpc/capacity-gateway.js';
import { HttpPaymentRail } from '#src/funding/adapters/out/http/payment-rail.js';
import { TenantTokenProvider } from '#src/funding/adapters/out/oauth/token-provider.js';
import { createPersistence, type Persistence } from '#src/funding/adapters/out/postgres/db.js';
import { migrate } from '#src/funding/adapters/out/postgres/migrate.js';
import { PostgresSagaStore } from '#src/funding/adapters/out/postgres/saga-store.js';
import { SagaDriver, type DriverHooks } from '#src/funding/application/saga-driver.js';
import { CreateFundingRequest } from '#src/funding/application/funding-requests.js';
import { PostgresUnitOfWork } from '#src/funding/adapters/out/postgres/unit-of-work.js';
import { DEFAULT_SAGA_CONFIG, type SagaConfig } from '#src/funding/domain/index.js';
import { startFundingPostgres, type FundingPostgres } from './postgres.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const PAYMENTS_MAIN = fileURLToPath(new URL('../../../payments-mock/src/main.ts', import.meta.url));
const OAUTH_CONFIG = fileURLToPath(
  new URL('../../../../deploy/oauth/config.json', import.meta.url),
);
const TOXIPROXY_IMAGE = 'ghcr.io/shopify/toxiproxy:2.12.0';

function freePort(): Promise<number> {
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

/** The payments mock as a separate process: services share no code (ADR 027). */
async function startPaymentsMock(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const ops = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', PAYMENTS_MAIN], {
    cwd: REPO,
    env: { ...process.env, PAYMENTS_PORT: port.toString(), PAYMENTS_OPS_PORT: ops.toString() },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port.toString()}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const up = await fetch(`http://127.0.0.1:${ops.toString()}/health/live`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (Date.now() > deadline) throw new Error('payments mock did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
        }, 3_000).unref();
      }),
  };
}

export interface SystemStack {
  readonly postgres: FundingPostgres;
  readonly persistence: Persistence;
  readonly store: PostgresSagaStore;
  readonly capacityDb: pg.Pool;
  readonly paymentsUrl: string;
  /** A release sent straight to capacity, answer unmasked (code and `ErrorInfo.reason`). */
  rawRelease(input: {
    tenantId: string;
    programId: string;
    reservationId: string;
    releaseRef: string;
    key: string;
  }): Promise<{ ok: true } | { ok: false; code: string; reason: string | undefined }>;
  /** Mints a token from the mock as a client would: `params` are the form fields. */
  mint(params: Record<string, string>): Promise<Record<string, unknown>>;
  /** Toxiproxy in front of capacity's gRPC port; funding's gateway dials this. */
  readonly capacityProxy: CreatedProxy;
  readonly gateway: GrpcCapacityGateway;
  seedProgram(input: {
    tenantId: string;
    id: string;
    currency: string;
    limitMinor: bigint;
  }): Promise<void>;
  driver(options?: {
    saga?: Partial<SagaConfig>;
    hooks?: DriverHooks;
    leaseMs?: number;
  }): SagaDriver;
  submit(input: {
    tenantId: string;
    programId: string;
    invoiceId: string;
    value: string;
    currency?: string;
  }): Promise<string>;
  funding(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  capacity(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  drain(driver: SagaDriver, max?: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Capacity (the real image, api role, gRPC on 50051 behind Toxiproxy), PostgreSQL with both
 * databases, mock OAuth2 with the committed mappings, and the payments mock (ADR 025, T11).
 */
export async function startSystemStack(): Promise<SystemStack> {
  const network: StartedNetwork = await new Network().start();
  const postgres = await startFundingPostgres(network);
  const oauthPort = await freePort();
  const issuer = `http://localhost:${oauthPort.toString()}/default`;

  const oauth: StartedTestContainer = await new GenericContainer(
    'ghcr.io/navikt/mock-oauth2-server:3.0.1',
  )
    .withNetwork(network)
    .withNetworkAliases('oauth')
    .withEnvironment({ JSON_CONFIG_PATH: '/config/config.json' })
    .withCopyFilesToContainer([{ source: OAUTH_CONFIG, target: '/config/config.json' }])
    .withExposedPorts({ container: 8080, host: oauthPort })
    .withWaitStrategy(Wait.forHttp('/default/.well-known/openid-configuration', 8080))
    .start();

  const imageTag = 'program-capacity-service:ms-system';
  await GenericContainer.fromDockerfile(REPO, 'Dockerfile').build(imageTag, {
    deleteOnExit: false,
  });
  const capacityEnv = {
    DATABASE_URL: 'postgres://capacity:capacity@postgres:5432/capacity',
    KAFKA_BROKERS: '127.0.0.1:1',
    OAUTH_ISSUER: issuer,
    OAUTH_AUDIENCE: 'capacity-service',
    OAUTH_JWKS_URL: 'http://oauth:8080/default/jwks',
    LOG_LEVEL: 'info',
  };
  await new GenericContainer(imageTag)
    .withNetwork(network)
    .withEnvironment(capacityEnv)
    .withCommand(['node', 'src/capacity/adapters/out/postgres/migrate.js'])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start()
    .then((c) => c.stop());
  const capacityApi = await new GenericContainer(imageTag)
    .withNetwork(network)
    .withNetworkAliases('capacity')
    .withEnvironment({
      ...capacityEnv,
      APP_ROLE: 'api',
      HTTP_PORT: '3000',
      GRPC_PORT: '50051',
      OPS_PORT: '9464',
    })
    .withExposedPorts(9464)
    .withWaitStrategy(Wait.forHttp('/health/ready', 9464).withStartupTimeout(120_000))
    .start();

  const toxiproxy = await new ToxiProxyContainer(TOXIPROXY_IMAGE).withNetwork(network).start();
  const capacityProxy = await toxiproxy.createProxy({
    name: 'capacity',
    upstream: 'capacity:50051',
  });

  const payments = await startPaymentsMock();
  await migrate(postgres.fundingUrl);
  const persistence = createPersistence(postgres.fundingUrl);
  const store = new PostgresSagaStore(persistence);
  const capacityDb = new pg.Pool({ connectionString: postgres.capacityUrl, max: 2 });
  const funding = persistence.pool;

  const tokens = new TenantTokenProvider({
    tokenUrl: `http://127.0.0.1:${oauthPort.toString()}/default/token`,
    clientIdPrefix: 'funding-service',
    clientSecret: 'funding-service',
    scope: 'capacity:write',
    issuerHost: `localhost:${oauthPort.toString()}`,
  });
  const target = `${capacityProxy.host}:${capacityProxy.port.toString()}`;
  const raw = new CapacityServiceClient(target, credentials.createInsecure());
  const gateway = new GrpcCapacityGateway({
    target,
    deadlineMs: 21_000,
    tokens: new TenantTokenProvider({
      tokenUrl: `http://127.0.0.1:${oauthPort.toString()}/default/token`,
      clientIdPrefix: 'funding-service',
      clientSecret: 'funding-service',
      scope: 'capacity:write',
      issuerHost: `localhost:${oauthPort.toString()}`,
    }),
  });
  const rail = new HttpPaymentRail({ baseUrl: payments.baseUrl, timeoutMs: 2_000 });
  const create = new CreateFundingRequest(new PostgresUnitOfWork(persistence));

  return {
    postgres,
    persistence,
    store,
    capacityDb,
    paymentsUrl: payments.baseUrl,
    rawRelease: async (input) => {
      const metadata = new Metadata();
      metadata.set('authorization', `Bearer ${await tokens.tokenFor(input.tenantId)}`);
      metadata.set('idempotency-key', input.key);
      return new Promise((resolve) => {
        raw.release(
          {
            programId: input.programId,
            reservationId: input.reservationId,
            releaseRef: input.releaseRef,
            amount: undefined,
            reason: ReleaseReason.RELEASE_REASON_CANCELLED,
          },
          metadata,
          { deadline: Date.now() + 10_000 },
          (error: ServiceError | null) => {
            if (error === null) {
              resolve({ ok: true });
              return;
            }
            const bytes = error.metadata.get('grpc-status-details-bin')[0];
            resolve({
              ok: false,
              code: status[error.code],
              reason: bytes instanceof Buffer ? errorReasonOf(bytes) : undefined,
            });
          },
        );
      });
    },
    mint: async (params) => {
      const response = await fetch(`http://127.0.0.1:${oauthPort.toString()}/default/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', ...params }),
      });
      const { access_token: jwt } = (await response.json()) as { access_token: string };
      return JSON.parse(
        Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
    },
    capacityProxy,
    gateway,
    seedProgram: async (input) => {
      await capacityDb.query(
        `INSERT INTO program (tenant_id, id, currency, credit_limit_minor, reserved_minor, status)
         VALUES ($1, $2, $3, $4::bigint, 0, 'ACTIVE')`,
        [input.tenantId, input.id, input.currency, input.limitMinor.toString()],
      );
    },
    driver: (options = {}) =>
      new SagaDriver(
        store,
        gateway,
        rail,
        {
          owner: `system-${Math.random().toString(36).slice(2)}`,
          leaseMs: options.leaseMs ?? 30_000,
          batchSize: 10,
          saga: { ...DEFAULT_SAGA_CONFIG, ...options.saga },
          risk: { limits: { USD: 100_000_000n, EUR: 100_000_000n } },
        },
        options.hooks,
        () => 0,
      ),
    submit: async (input) => {
      const outcome = await create.execute({
        tenantId: input.tenantId,
        idempotencyKey: undefined,
        programId: input.programId,
        invoiceId: input.invoiceId,
        amount: { value: input.value, currency: input.currency ?? 'USD' },
      });
      if (!outcome.ok) throw new Error(`submit refused: ${outcome.problem.type}`);
      return outcome.value.id;
    },
    funding: async (sql, params = []) =>
      (await funding.query(sql, params)).rows as Record<string, unknown>[],
    capacity: async (sql, params = []) =>
      (await capacityDb.query(sql, params)).rows as Record<string, unknown>[],
    drain: async (driver, max = 100) => {
      for (let round = 0; round < max; round += 1) {
        if ((await driver.runOnce()) === 0) return;
      }
    },
    close: async () => {
      raw.close();
      gateway.close();
      await capacityDb.end();
      await persistence.close();
      await payments.stop();
      await toxiproxy.stop();
      await capacityApi.stop();
      await oauth.stop();
      await postgres.stop();
      await network.stop();
    },
  };
}
