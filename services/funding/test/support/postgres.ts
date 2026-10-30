import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export const POSTGRES_IMAGE = 'postgres:18';

const INIT_SCRIPT = fileURLToPath(
  new URL('../../../../deploy/postgres/init-databases.sh', import.meta.url),
);

export interface FundingPostgres {
  /** Connection URL of the `funding` database as the `funding` role. */
  readonly fundingUrl: string;
  /** Connection URL of the `capacity` database as the `capacity` role. */
  readonly capacityUrl: string;
  url(user: string, password: string, database: string): string;
  stop(): Promise<void>;
}

/**
 * One server as in compose: bootstrap role `postgres`, then the same init script the
 * compose stack mounts creates the `capacity` and `funding` roles and databases.
 */
export async function startFundingPostgres(): Promise<FundingPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyFilesToContainer([
      {
        source: INIT_SCRIPT,
        target: '/docker-entrypoint-initdb.d/10-init-databases.sh',
        mode: 0o755,
      },
    ])
    .start();
  const url = (user: string, password: string, database: string): string =>
    `postgres://${user}:${password}@${container.getHost()}:${container.getPort().toString()}/${database}`;
  return {
    fundingUrl: url('funding', 'funding', 'funding'),
    capacityUrl: url('capacity', 'capacity', 'capacity'),
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
