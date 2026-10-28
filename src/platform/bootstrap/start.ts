import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';
import { createPersistence } from '#src/capacity/adapters/out/postgres/db.js';
import type { Config } from '../config/config.js';
import { createAuthMiddleware, JwtVerifier } from '#src/capacity/adapters/in/http/auth.js';
import { buildOpenApiDocument } from '#src/capacity/adapters/in/http/openapi.js';
import { startOpsServer, type OpsServer } from '../health/ops-server.js';
import { renderApiDocs } from '../health/api-docs.js';
import { NestPinoLogger, type Logger } from '../logging/logger.js';
import { AppModule } from './app.module.js';
import { createTreasuryConsumer } from './worker.js';

export interface RunningApp {
  readonly opsPort: number;
  /** Null for the `worker` role, which has no business HTTP listener. */
  readonly httpPort: number | null;
  /** Drain readiness, close intake, then the pool and the ops server. Idempotent. */
  close(): Promise<void>;
}

export async function startApp(config: Config, logger: Logger): Promise<RunningApp> {
  const persistence = createPersistence(config.databaseUrl);
  const nestLogger = new NestPinoLogger(logger);
  const serveHttp = config.appRole === 'api' || config.appRole === 'all';
  const module = AppModule.register(
    persistence,
    serveHttp ? { fxMaxAgeSeconds: config.fxMaxAgeSeconds } : undefined,
  );
  let app: INestApplication | INestApplicationContext;
  if (serveHttp) {
    const http = await NestFactory.create(module, { logger: nestLogger });
    // Mounted before Nest registers the body parser (at init), so authentication comes first.
    http.use(
      '/v1',
      createAuthMiddleware(
        new JwtVerifier({
          issuer: config.oauthIssuer,
          audience: config.oauthAudience,
          jwksUrl: config.oauthJwksUrl,
        }),
      ),
    );
    await http.listen(config.httpPort, '0.0.0.0');
    app = http;
  } else {
    app = await NestFactory.createApplicationContext(module, { logger: nestLogger });
  }

  const consumeTreasury = config.appRole === 'worker' || config.appRole === 'all';
  const consumer = consumeTreasury ? createTreasuryConsumer(config, persistence, logger) : null;
  await consumer?.start();

  const ops: OpsServer = await startOpsServer({
    port: config.opsPort,
    documents: serveHttp ? renderApiDocs(buildOpenApiDocument()) : {},
    checks: {
      db: async () => {
        await sql`select 1`.execute(persistence.db);
      },
      ...(consumer === null ? {} : { kafka: () => consumer.check() }),
    },
  });

  logger.info(
    { role: config.appRole, httpPort: serveHttp ? config.httpPort : null, opsPort: ops.port() },
    'service started',
  );

  let closing: Promise<void> | undefined;
  return {
    opsPort: ops.port(),
    httpPort: serveHttp ? config.httpPort : null,
    close: () => {
      closing ??= (async () => {
        ops.markDraining();
        // Stop intake first: an in-flight message finishes its transaction before the pool closes.
        await consumer?.stop();
        await app.close();
        await ops.close();
        logger.info('service stopped');
      })();
      return closing;
    },
  };
}
