import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { Registry } from 'prom-client';
import { createPersistence } from '#src/capacity/adapters/out/postgres/db.js';
import { latestMigration } from '#src/capacity/adapters/out/postgres/migrate.js';
import type { Config } from '../config/config.js';
import { JwtVerifier } from '#src/capacity/adapters/in/boundary/auth.js';
import { createGrpcServer, type GrpcServer } from '#src/capacity/adapters/in/grpc/server.js';
import { createAuthMiddleware } from '#src/capacity/adapters/in/http/auth.js';
import {
  GET_CAPACITY,
  RELEASE_RESERVATION,
  RESERVE_CAPACITY,
} from '#src/capacity/adapters/in/http/capacity.controller.js';
import type { GetCapacity } from '#src/capacity/application/use-cases/queries/get-capacity/get-capacity.js';
import type { ReleaseReservation } from '#src/capacity/application/use-cases/release-reservation/release-reservation.js';
import type { ReserveCapacity } from '#src/capacity/application/use-cases/reserve-capacity/reserve-capacity.js';
import { buildOpenApiDocument } from '#src/capacity/adapters/in/http/openapi.js';
import { buildAsyncApiDocument } from '#src/platform/contracts/asyncapi.js';
import { startOpsServer, type OpsServer } from '../health/ops-server.js';
import { renderApiDocs, renderAsyncApiDocs } from '../health/api-docs.js';
import { NestPinoLogger, type Logger } from '../logging/logger.js';
import { httpMetrics } from '../telemetry/http-metrics.js';
import { loadRuntimeSettings, type RuntimeSettings } from '../telemetry/settings.js';
import { AppModule } from './app.module.js';
import { SHUTDOWN_DEADLINE_MS } from './shutdown.js';
import { createTreasuryConsumer, startWorkerComponents, type WorkerComponents } from './worker.js';

/**
 * NFR-07: the consumer drain gets 40 % of the shutdown deadline, which leaves the rest for the
 * relay and job stop, the pool and the ops server.
 */
const CONSUMER_DRAIN_MS = Math.floor(SHUTDOWN_DEADLINE_MS * 0.4);

/** ADR 024: in-flight gRPC calls get 40 % of the NFR-07 budget, then the server is forced down. */
const GRPC_DRAIN_MS = CONSUMER_DRAIN_MS;

export interface RunningApp {
  readonly opsPort: number;
  /** Null for the `worker` role, which has no business HTTP listener. */
  readonly httpPort: number | null;
  /** Null for the `worker` role: only the api role serves gRPC (ADR 024). */
  readonly grpcPort: number | null;
  /** Drain readiness, close intake, then the pool and the ops server. Idempotent. */
  close(): Promise<void>;
}

export async function startApp(
  config: Config,
  logger: Logger,
  settings: RuntimeSettings = loadRuntimeSettings(process.env),
): Promise<RunningApp> {
  const persistence = createPersistence(config.databaseUrl);
  const registry = new Registry();
  const nestLogger = new NestPinoLogger(logger);
  const serveHttp = config.appRole === 'api' || config.appRole === 'all';
  const module = AppModule.register(
    persistence,
    serveHttp ? { fxMaxAgeSeconds: config.fxMaxAgeSeconds } : undefined,
  );
  let app: INestApplication | INestApplicationContext;
  let grpc: GrpcServer | null = null;
  let grpcPort: number | null = null;
  if (serveHttp) {
    const http = await NestFactory.create(module, { logger: nestLogger });
    http.use(httpMetrics(registry));
    // Before authentication: a CORS preflight carries no token. Off unless origins are listed.
    if (config.corsOrigins.length > 0) {
      http.enableCors({
        origin: [...config.corsOrigins],
        allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-none-match'],
        exposedHeaders: ['etag', 'location'],
        maxAge: 600,
      });
    }
    // Mounted before Nest registers the body parser (at init), so authentication comes first.
    const verifier = new JwtVerifier({
      issuer: config.oauthIssuer,
      audience: config.oauthAudience,
      jwksUrl: config.oauthJwksUrl,
    });
    http.use('/v1', createAuthMiddleware(verifier));
    await http.listen(config.httpPort, '0.0.0.0');
    // The same use cases, verifier and metrics registry as REST (ADR 024).
    grpc = createGrpcServer({
      verifier,
      reserveCapacity: http.get<ReserveCapacity>(RESERVE_CAPACITY),
      releaseReservation: http.get<ReleaseReservation>(RELEASE_RESERVATION),
      getCapacity: http.get<GetCapacity>(GET_CAPACITY),
      registry,
      onError: (error) => {
        logger.error({ err: error }, 'gRPC call failed');
      },
    });
    grpcPort = await grpc.listen(config.grpcPort);
    app = http;
  } else {
    app = await NestFactory.createApplicationContext(module, { logger: nestLogger });
  }

  const consumeTreasury = config.appRole === 'worker' || config.appRole === 'all';
  const consumer = consumeTreasury
    ? createTreasuryConsumer(config, persistence, logger, registry, CONSUMER_DRAIN_MS)
    : null;
  await consumer?.start();

  // The api role never touches Kafka: only the worker role runs the relay and jobs (NFR-06).
  const worker: WorkerComponents | null =
    config.appRole === 'api'
      ? null
      : startWorkerComponents(persistence, config, settings, logger, registry);

  const latest = await latestMigration();
  const ops: OpsServer = await startOpsServer({
    registry,
    port: config.opsPort,
    documents: serveHttp
      ? {
          ...renderApiDocs(buildOpenApiDocument(), { tokenUrl: config.oauthTokenUrl }),
          ...renderAsyncApiDocs(buildAsyncApiDocument({ payloads: 'inline' })),
        }
      : {},
    checks: {
      db: async () => {
        // The newest migration file must be recorded, so a half-migrated schema is not ready.
        const { rows } = await sql<{ migrated: boolean }>`
          SELECT to_regclass('public.schema_migrations') IS NOT NULL
             AND EXISTS (SELECT 1 FROM schema_migrations WHERE filename = ${latest})
                 AS migrated`.execute(persistence.db);
        if (rows[0]?.migrated !== true) throw new Error('schema is not migrated');
      },
      ...(grpc === null ? {} : { grpc: () => grpc.check() }),
      ...(consumer === null ? {} : { kafka: () => consumer.check() }),
    },
  });

  logger.info(
    {
      role: config.appRole,
      httpPort: serveHttp ? config.httpPort : null,
      grpcPort,
      opsPort: ops.port(),
    },
    'service started',
  );

  let closing: Promise<void> | undefined;
  return {
    opsPort: ops.port(),
    httpPort: serveHttp ? config.httpPort : null,
    grpcPort,
    close: () => {
      closing ??= (async () => {
        ops.markDraining();
        // Refuse new gRPC calls and let in-flight ones finish before the pool can close.
        await grpc?.drain(GRPC_DRAIN_MS);
        // Stop intake first: an in-flight message finishes its transaction before the pool closes.
        await consumer?.stop();
        // Background work next: it uses the pool that the app closes last.
        await worker?.stop();
        await app.close();
        await ops.close();
        logger.info('service stopped');
      })();
      return closing;
    },
  };
}
