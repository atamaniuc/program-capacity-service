import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export const POSTGRES_IMAGE = 'postgres:18';

export interface TestPostgres {
  readonly url: string;
  stop(): Promise<void>;
}

/** A throwaway PostgreSQL 18 for integration and e2e tests. */
export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('capacity')
    .withUsername('capacity')
    .withPassword('capacity')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
