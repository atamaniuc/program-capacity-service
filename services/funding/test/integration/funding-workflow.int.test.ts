import { expect, it, vi } from 'vitest';
import { createPersistence } from '#src/funding/adapters/out/postgres/db.js';
import { openFundingWorkflows } from '#src/funding/adapters/out/postgres/funding-workflow.js';
import { migrate } from '#src/funding/adapters/out/postgres/migrate.js';
import { PostgresSagaStore } from '#src/funding/adapters/out/postgres/saga-store.js';
import { PostgresUnitOfWork } from '#src/funding/adapters/out/postgres/unit-of-work.js';
import { CreateFundingRequest } from '#src/funding/application/funding-requests.js';
import { SagaDriver } from '#src/funding/application/saga-driver.js';
import type { PaymentRail } from '#src/funding/application/saga-ports.js';
import { DEFAULT_SAGA_CONFIG } from '#src/funding/domain/index.js';
import { startFundingPostgres } from '../support/postgres.js';

it('FS-06 records payment decline compensation after a durable retry', async () => {
  const postgres = await startFundingPostgres();
  const persistence = createPersistence(postgres.fundingUrl);
  let workflowWorker: Awaited<ReturnType<typeof openFundingWorkflows>> | undefined;
  try {
    await migrate(postgres.fundingUrl);
    const api = await openFundingWorkflows(persistence, false);
    const uow = new PostgresUnitOfWork(persistence, undefined, api.start);
    const request = { tenantId: 'bank-a', programId: 'program-1', invoiceId: 'invoice-1' };
    const create = new CreateFundingRequest(uow);
    let rolledBackId: string | undefined;
    let id: string;
    try {
      await expect(
        uow.run(async (tx) => {
          const { record } = await tx.insertRequest({
            ...request,
            invoiceId: 'rollback',
            amountMinor: 1_000n,
            currency: 'USD',
          });
          rolledBackId = record.id;
          throw new Error('rollback funding insert');
        }),
      ).rejects.toThrow('rollback funding insert');
      const receipt = await create.execute({
        ...request,
        idempotencyKey: undefined,
        amount: { currency: 'USD', value: '10.00' },
      });
      if (!receipt.ok) throw new Error(receipt.problem.type);
      id = receipt.value.id;
    } finally {
      await api.close();
    }

    const queued = await persistence.pool.query<{ id: string }>(
      'SELECT id FROM nest_workflows.instances',
    );
    const persisted = await persistence.pool.query<{ id: string }>(
      'SELECT id FROM funding_request',
    );
    expect(rolledBackId).toEqual(expect.any(String));
    expect(persisted.rows).toEqual([{ id }]);
    expect(queued.rows).toEqual([{ id: `funding:${id}` }]);

    const store = new PostgresSagaStore(persistence);
    const worker = { owner: 'workflow-test', batchSize: 2, leaseMs: 1_000, pollIntervalMs: 20 };
    const reserve = vi.fn(async () => ({ kind: 'created', reservationId: 'reserve-1' }) as const);
    const release = vi.fn(async () => ({ kind: 'released' }) as const);
    const disburse = vi
      .fn<PaymentRail['disburse']>()
      .mockResolvedValue({ kind: 'declined' })
      .mockResolvedValueOnce({ kind: 'unknown' });
    const driver = new SagaDriver(
      store,
      { reserve, release },
      { disburse },
      { ...worker, saga: DEFAULT_SAGA_CONFIG, risk: { limits: { USD: 10_000n } } },
      {},
      () => 0.5,
    );
    workflowWorker = await openFundingWorkflows(persistence, { ...worker, store, driver });
    await vi.waitFor(
      async () => {
        const result = await persistence.pool.query<{ status: string }>(
          'SELECT status FROM nest_workflows.instances WHERE id = $1',
          [`funding:${id}`],
        );
        expect(result.rows[0]?.status).toBe('completed');
      },
      { timeout: 5_000 },
    );
    const state = await persistence.db
      .selectFrom('funding_request')
      .select('state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(state.state).toBe('FAILED');
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(disburse).toHaveBeenCalledTimes(2);
    expect(disburse).toHaveBeenNthCalledWith(2, expect.objectContaining({ lookupFirst: true }));
    expect(disburse.mock.calls[0]?.[0].key).toBe(disburse.mock.calls[1]?.[0].key);
    expect(release).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reservationId: 'reserve-1' }),
    );
  } finally {
    await workflowWorker?.close();
    await persistence.close();
    await postgres.stop();
  }
}, 180_000);
