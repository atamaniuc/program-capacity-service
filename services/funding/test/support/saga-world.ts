import { randomUUID } from 'node:crypto';
import { CreateFundingRequest } from '#src/funding/application/funding-requests.js';
import { SagaDriver, type DriverHooks } from '#src/funding/application/saga-driver.js';
import type {
  CapacityGateway,
  DisburseCall,
  PaymentRail,
  TenantTokens,
} from '#src/funding/application/saga-ports.js';
import { GrpcCapacityGateway } from '#src/funding/adapters/out/grpc/capacity-gateway.js';
import { createPersistence, type Persistence } from '#src/funding/adapters/out/postgres/db.js';
import { migrate } from '#src/funding/adapters/out/postgres/migrate.js';
import { PostgresSagaStore } from '#src/funding/adapters/out/postgres/saga-store.js';
import { PostgresUnitOfWork } from '#src/funding/adapters/out/postgres/unit-of-work.js';
import {
  DEFAULT_SAGA_CONFIG,
  type DisburseOutcome,
  type SagaConfig,
} from '#src/funding/domain/index.js';
import { startFakeCapacity, type FakeCapacity } from './fake-capacity.js';
import { startFundingPostgres, type FundingPostgres } from './postgres.js';

export class FakeRail implements PaymentRail {
  readonly calls: DisburseCall[] = [];
  onDisburse: (call: DisburseCall, index: number) => DisburseOutcome = () => ({
    kind: 'paid',
    paymentId: 'pay-1',
  });
  disburse(call: DisburseCall): Promise<DisburseOutcome> {
    this.calls.push(call);
    return Promise.resolve(this.onDisburse(call, this.calls.length - 1));
  }
}

const tokens: TenantTokens = {
  tokenFor: (tenantId) => Promise.resolve(`jwt-${tenantId}`),
  invalidate: () => undefined,
};

export interface SagaWorld {
  readonly postgres: FundingPostgres;
  readonly persistence: Persistence;
  readonly store: PostgresSagaStore;
  readonly capacity: FakeCapacity;
  readonly rail: FakeRail;
  readonly gateway: CapacityGateway;
  /** A driver over the world's store, capacity fake and rail fake. */
  driver(options?: {
    saga?: Partial<SagaConfig>;
    hooks?: DriverHooks;
    gateway?: CapacityGateway;
    owner?: string;
    leaseMs?: number;
    batchSize?: number;
  }): SagaDriver;
  /** Creates a request through the API use case (RECEIVED, outbox row), returns its id. */
  submit(input: {
    tenantId?: string;
    programId?: string;
    invoiceId: string;
    value?: string;
    currency?: string;
  }): Promise<string>;
  row(id: string): Promise<Record<string, unknown>>;
  attempts(id: string): Promise<{ step: string; outcome_class: string; state_after: string }[]>;
  outbox(id: string): Promise<string[]>;
  /** Runs the driver until no step is due, at most `max` rounds. */
  drain(driver: SagaDriver, max?: number): Promise<number>;
  close(): Promise<void>;
}

export async function startSagaWorld(): Promise<SagaWorld> {
  const postgres = await startFundingPostgres();
  await migrate(postgres.fundingUrl);
  const persistence = createPersistence(postgres.fundingUrl);
  const store = new PostgresSagaStore(persistence);
  const capacity = await startFakeCapacity();
  const rail = new FakeRail();
  const gateway = new GrpcCapacityGateway({ target: capacity.target, tokens, deadlineMs: 2_000 });
  const create = new CreateFundingRequest(new PostgresUnitOfWork(persistence));
  const pool = persistence.pool;
  const risk = { limits: { USD: 100_000_000n, EUR: 100_000_000n } };

  const world: SagaWorld = {
    postgres,
    persistence,
    store,
    capacity,
    rail,
    gateway,
    driver: (options = {}) =>
      new SagaDriver(
        store,
        options.gateway ?? gateway,
        rail,
        {
          owner: options.owner ?? `test-${randomUUID()}`,
          leaseMs: options.leaseMs ?? 30_000,
          batchSize: options.batchSize ?? 10,
          saga: { ...DEFAULT_SAGA_CONFIG, ...options.saga },
          risk,
        },
        options.hooks,
        () => 0,
      ),
    submit: async (input) => {
      const outcome = await create.execute({
        tenantId: input.tenantId ?? 'bank-a',
        idempotencyKey: undefined,
        programId: input.programId ?? 'prg_1',
        invoiceId: input.invoiceId,
        amount: { value: input.value ?? '1250.50', currency: input.currency ?? 'USD' },
      });
      if (!outcome.ok) throw new Error(`submit refused: ${outcome.problem.type}`);
      return outcome.value.id;
    },
    row: async (id) => {
      const { rows } = await pool.query('SELECT * FROM funding_request WHERE id = $1', [id]);
      return rows[0] as Record<string, unknown>;
    },
    attempts: async (id) => {
      const { rows } = await pool.query(
        'SELECT step, outcome_class, state_after FROM saga_step_attempt WHERE request_id = $1 ORDER BY created_at, id',
        [id],
      );
      return rows as { step: string; outcome_class: string; state_after: string }[];
    },
    outbox: async (id) => {
      const { rows } = await pool.query<{ type: string }>(
        'SELECT type FROM outbox_event WHERE request_id = $1 ORDER BY created_at, id',
        [id],
      );
      return rows.map((r) => r.type);
    },
    drain: async (driver, max = 50) => {
      let steps = 0;
      for (let round = 0; round < max; round += 1) {
        const ran = await driver.runOnce();
        if (ran === 0) break;
        steps += ran;
      }
      return steps;
    },
    close: async () => {
      gateway.close();
      await capacity.close();
      await persistence.close();
      await postgres.stop();
    },
  };
  return world;
}
