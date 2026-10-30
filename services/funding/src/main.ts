import { CreateFundingRequest, GetFundingRequest } from './funding/application/funding-requests.js';
import { JwtVerifier } from './funding/adapters/in/http/auth.js';
import { createHttpServer } from './funding/adapters/in/http/server.js';
import { createPersistence } from './funding/adapters/out/postgres/db.js';
import { PostgresUnitOfWork } from './funding/adapters/out/postgres/unit-of-work.js';
import { PostgresSagaStore } from './funding/adapters/out/postgres/saga-store.js';
import { startOpsServer } from './ops/ops-server.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const persistence = createPersistence(config.DATABASE_URL);
const uow = new PostgresUnitOfWork(persistence);
const ops = await startOpsServer({
  port: config.OPS_PORT,
  checks: { db: () => new PostgresSagaStore(persistence).ping() },
});
const server = createHttpServer({
  verifier: new JwtVerifier({
    issuer: config.OAUTH_ISSUER,
    audience: config.OAUTH_AUDIENCE,
    jwksUrl: config.OAUTH_JWKS_URL,
  }),
  create: new CreateFundingRequest(uow),
  get: new GetFundingRequest(uow),
  onError: (error) => {
    console.error(JSON.stringify({ level: 'error', msg: 'request failed', error: String(error) }));
  },
});

server.listen(config.HTTP_PORT, '0.0.0.0', () => {
  console.log(
    JSON.stringify({ level: 'info', msg: 'funding api listening', port: config.HTTP_PORT }),
  );
});

const stop = (): void => {
  ops.markDraining();
  server.close(() => {
    Promise.all([ops.close(), persistence.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  server.closeIdleConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
