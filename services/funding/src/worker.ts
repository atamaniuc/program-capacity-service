import { randomUUID } from 'node:crypto';
import { Registry } from 'prom-client';
import { SagaDriver } from './funding/application/saga-driver.js';
import { GrpcCapacityGateway } from './funding/adapters/out/grpc/capacity-gateway.js';
import { HttpPaymentRail } from './funding/adapters/out/http/payment-rail.js';
import { TenantTokenProvider } from './funding/adapters/out/oauth/token-provider.js';
import { createPersistence } from './funding/adapters/out/postgres/db.js';
import { openFundingWorkflows } from './funding/adapters/out/postgres/funding-workflow.js';
import { PostgresSagaStore } from './funding/adapters/out/postgres/saga-store.js';
import { startOpsServer } from './ops/ops-server.js';
import { registerSagaMetrics } from './ops/metrics.js';
import { loadWorkerConfig } from './worker-config.js';

const config = loadWorkerConfig(process.env);
const persistence = createPersistence(config.databaseUrl);
const gateway = new GrpcCapacityGateway({
  target: config.capacityTarget,
  deadlineMs: config.grpcDeadlineMs,
  tokens: new TenantTokenProvider({
    tokenUrl: config.tokenUrl,
    clientIdPrefix: 'funding-service',
    clientSecret: config.clientSecret,
    scope: 'capacity:write',
    issuerHost: config.issuerHost,
    timeoutMs: config.tokenTimeoutMs,
  }),
});
const log = (level: string, msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ level, msg, ...extra }));
};
const store = new PostgresSagaStore(persistence);
const registry = new Registry();
const metrics = registerSagaMetrics(registry, () => store.stats());
const owner = `worker-${randomUUID()}`;
const driver = new SagaDriver(
  store,
  gateway,
  new HttpPaymentRail({ baseUrl: config.paymentsBaseUrl, timeoutMs: config.paymentTimeoutMs }),
  {
    owner,
    leaseMs: config.leaseMs,
    batchSize: config.batchSize,
    saga: config.saga,
    risk: config.risk,
  },
  {
    onAlert: (claim, transition) => {
      log('error', 'funding request needs attention', {
        id: claim.request.id,
        reason: transition.request.reason,
      });
    },
    onRecorded: (claim, transition) => {
      metrics.recorded(claim, transition);
    },
    onDropped: (claim, reason) => {
      log('warn', 'step result dropped', { id: claim.request.id, reason });
    },
    onError: (claim, error) => {
      log('error', 'step failed', { id: claim.request.id, error: String(error) });
    },
  },
);

const workflows = await openFundingWorkflows(persistence, {
  driver,
  store,
  owner,
  leaseMs: config.leaseMs,
  batchSize: config.batchSize,
  pollIntervalMs: config.pollIntervalMs,
});
// Requests persisted before this version did not enqueue a workflow.
for (const id of await store.pendingIds()) await workflows.start(id);
const ops = await startOpsServer({
  registry,
  port: config.opsPort,
  checks: { db: () => store.ping() },
});
log('info', 'funding workflow worker started');

const stop = async (): Promise<void> => {
  ops.markDraining();
  try {
    await workflows.close();
    await ops.close();
    gateway.close();
    await persistence.close();
  } catch (error) {
    log('error', 'worker shutdown failed', { error: String(error) });
    process.exit(1);
  }
};
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
