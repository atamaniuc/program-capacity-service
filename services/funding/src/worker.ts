import { randomUUID } from 'node:crypto';
import { Registry } from 'prom-client';
import { SagaDriver } from './funding/application/saga-driver.js';
import { GrpcCapacityGateway } from './funding/adapters/out/grpc/capacity-gateway.js';
import { HttpPaymentRail } from './funding/adapters/out/http/payment-rail.js';
import { TenantTokenProvider } from './funding/adapters/out/oauth/token-provider.js';
import { createPersistence } from './funding/adapters/out/postgres/db.js';
import { PostgresSagaStore } from './funding/adapters/out/postgres/saga-store.js';
import { startOpsServer } from './ops/ops-server.js';
import { loopAlive, registerSagaMetrics } from './ops/metrics.js';
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
const ops = await startOpsServer({
  registry,
  port: config.opsPort,
  checks: {
    db: () => store.ping(),
    // The driver loop must be ticking: a stalled loop is not ready (a long step is bounded by the lease).
    loop: loopAlive(metrics, 2 * config.leaseMs),
  },
});
const driver = new SagaDriver(
  store,
  gateway,
  new HttpPaymentRail({ baseUrl: config.paymentsBaseUrl, timeoutMs: config.paymentTimeoutMs }),
  {
    owner: `worker-${randomUUID()}`,
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

let stopping = false;
let wake: (() => void) | undefined;

async function loop(): Promise<void> {
  log('info', 'funding worker started');
  while (!stopping) {
    metrics.heartbeat();
    let ran = 0;
    try {
      ran = await driver.runOnce();
    } catch (error) {
      log('error', 'claim failed', { error: String(error) });
    }
    if (ran === 0 && !stopping) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, config.pollIntervalMs);
      });
    }
  }
}

const stop = (): void => {
  stopping = true;
  ops.markDraining();
  wake?.();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

loop()
  .then(async () => {
    gateway.close();
    await ops.close();
    await persistence.close();
  })
  .catch((error: unknown) => {
    log('error', 'worker crashed', { error: String(error) });
    process.exit(1);
  });
