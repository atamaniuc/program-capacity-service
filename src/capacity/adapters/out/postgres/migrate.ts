import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
/** Serialises concurrent migrate jobs; transaction-scoped, so no session state (NFR-15). */
const MIGRATION_LOCK_ID = 7_351_001;

export interface MigrationResult {
  readonly applied: readonly string[];
}

/** The file name of the newest migration; readiness requires it to be recorded. */
export async function latestMigration(directory: string = MIGRATIONS_DIR): Promise<string> {
  const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const latest = files.at(-1);
  if (latest === undefined) throw new Error(`no migration files in ${directory}`);
  return latest;
}

/** Applies every `NNNN_*.sql` file not yet recorded, in name order, one transaction per file. */
export async function migrate(
  databaseUrl: string,
  directory: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    for (const filename of files) {
      const sql = await readFile(new URL(filename, `file://${directory}`), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
        const table = await client.query<{ present: boolean }>(
          "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
        );
        const done = table.rows[0]?.present
          ? await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename])
          : { rowCount: 0 };
        if (done.rowCount === 0) {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
          applied.push(filename);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
  return { applied };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('migrate: DATABASE_URL is required');
    process.exit(1);
  }
  migrate(databaseUrl)
    .then(({ applied }) => {
      console.log(JSON.stringify({ msg: 'migrations applied', applied }));
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ msg: 'migration failed', error: String(error) }));
      process.exit(1);
    });
}
