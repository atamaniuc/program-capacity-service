import { randomUUID } from 'node:crypto';
import { SagaDriver } from './funding/application/saga-driver.js';
import { GrpcCapacityGateway } from './funding/adapters/out/grpc/capacity-gateway.js';
import { HttpPaymentRail } from './funding/adapters/out/http/payment-rail.js';
import { TenantTokenProvider } from './funding/adapters/out/oauth/token-provider.js';
import { createPersistence } from './funding/adapters/out/postgres/db.js';
import { PostgresSagaStore } from './funding/adapters/out/postgres/saga-store.js';
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
  }),
});
const log = (level: string, msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ level, msg, ...extra }));
};
const driver = new SagaDriver(
  new PostgresSagaStore(persistence),
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
  wake?.();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

loop()
  .then(async () => {
    gateway.close();
    await persistence.close();
  })
  .catch((error: unknown) => {
    log('error', 'worker crashed', { error: String(error) });
    process.exit(1);
  });
