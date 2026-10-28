import { loadConfig, ConfigError } from '#src/platform/config/config.js';
import { startApp } from '#src/platform/bootstrap/start.js';
import { createLogger } from '#src/platform/logging/logger.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const app = await startApp(config, logger);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown requested');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ error: String(error) }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(JSON.stringify({ level: 'fatal', msg: 'startup failed', error: String(error) }));
  }
  process.exit(1);
});
