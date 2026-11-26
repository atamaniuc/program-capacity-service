import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  Workflow,
  WorkflowClient,
  WorkflowStorage,
  WorkflowsModule,
  type WorkflowContext,
  type WorkflowRunner,
} from '@nestjs/workflows';
import { fromKysely, PostgresWorkflowStore } from '@nestjs/workflows/postgres';
import type { Transaction } from 'kysely';
import type { SagaDriver } from '../../../application/saga-driver.js';
import { nextCommand } from '../../../domain/index.js';
import type { Database, Persistence } from './db.js';
import type { PostgresSagaStore } from './saga-store.js';

interface FundingWorker {
  readonly driver: SagaDriver;
  readonly store: PostgresSagaStore;
  readonly owner: string;
  readonly leaseMs: number;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
}

@Workflow('funding-saga')
class FundingWorkflow implements WorkflowRunner<string, void> {
  constructor(private readonly worker: FundingWorker) {}

  async run(ctx: WorkflowContext, id: string): Promise<void> {
    for (let attempt = 1; attempt <= 250; attempt += 1) {
      const wakeAt = await ctx.step(`advance-${attempt.toString()}`, async () => {
        const { store, driver, owner, leaseMs } = this.worker;
        const claim = await store.claimRequest(id, owner, leaseMs);
        if (claim === undefined) return store.nextWakeAt(id);
        const transition = await driver.runStep(claim);
        if (transition === undefined) return store.nextWakeAt(id);
        return nextCommand(transition.request) === undefined
          ? null
          : transition.request.nextAttemptAt;
      });
      if (wakeAt === null) return;
      await ctx.sleep(`wait-${attempt.toString()}`, { until: wakeAt });
    }
    // A release with an unknown outcome can retry indefinitely. Resume it with a fresh journal.
    await ctx.startChild(FundingWorkflow, id, {
      id: `funding:${id}:${ctx.uuid()}`,
      parentClose: 'abandon',
      version: ctx.version,
    });
  }
}

export async function openFundingWorkflows(
  persistence: Persistence,
  worker: FundingWorker | false,
) {
  @Module({
    imports: [
      WorkflowsModule.forRoot({
        worker:
          worker === false
            ? false
            : {
                id: worker.owner,
                concurrency: worker.batchSize,
                leaseDuration: worker.leaseMs,
                pollInterval: Math.max(1, worker.pollIntervalMs),
              },
        retry: { attempts: 100, backoff: { delay: '1s', maxDelay: '1m' } },
      }),
    ],
    providers: [
      {
        provide: PostgresWorkflowStore,
        inject: [WorkflowStorage],
        useFactory: (storage: WorkflowStorage) =>
          // shortcut: apply the workflow schema at boot for local Compose; use a migration job before deployment.
          new PostgresWorkflowStore(
            { executor: fromKysely(persistence.db), migrate: true },
            storage,
          ),
      },
      ...(worker === false
        ? []
        : [{ provide: FundingWorkflow, useFactory: () => new FundingWorkflow(worker) }]),
    ],
  })
  class FundingWorkflowsModule {}

  const app = await NestFactory.createApplicationContext(FundingWorkflowsModule, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });
  const workflows = app.get(WorkflowClient);
  return {
    start: async (id: string, transaction?: Transaction<Database>): Promise<void> => {
      await workflows.start(FundingWorkflow, id, {
        id: `funding:${id}`,
        ...(transaction === undefined ? {} : { transaction }),
      });
    },
    close: () => app.close(),
  };
}
