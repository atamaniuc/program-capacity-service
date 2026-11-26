import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedNetwork } from 'testcontainers';

export const POSTGRES_IMAGE = 'postgres:18';

const INIT_SCRIPT = fileURLToPath(
  new URL('../../../../deploy/postgres/init-databases.sh', import.meta.url),
);

export interface FundingPostgres {
  /** Connection URL of the shared database as the `funding` role. */
  readonly fundingUrl: string;
  /** Connection URL of the shared database as the `capacity` role. */
  readonly capacityUrl: string;
  stop(): Promise<void>;
}

/**
 * One database as in Compose: the same bootstrap script creates the
 * `capacity` and `funding` roles and their schemas.
 */
export async function startFundingPostgres(network?: StartedNetwork): Promise<FundingPostgres> {
  const base = new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyFilesToContainer([
      {
        source: INIT_SCRIPT,
        target: '/docker-entrypoint-initdb.d/10-init-databases.sh',
        mode: 0o755,
      },
    ]);
  const container = await (
    network === undefined ? base : base.withNetwork(network).withNetworkAliases('postgres')
  ).start();
  const url = (role: 'capacity' | 'funding'): string =>
    `postgres://${role}:${role}@${container.getHost()}:${container.getPort().toString()}/finverity`;
  return {
    fundingUrl: url('funding'),
    capacityUrl: url('capacity'),
    stop: async () => {
      await container.stop();
    },
  };
}
