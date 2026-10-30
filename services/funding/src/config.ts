import * as z from 'zod';

const port = z.coerce.number().int().min(0).max(65535);

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  HTTP_PORT: port.default(3100),
  OAUTH_ISSUER: z.string().min(1),
  OAUTH_AUDIENCE: z.string().min(1).default('funding-service'),
  OAUTH_JWKS_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof Schema>;

/** Parses the environment once at boot; a bad value stops the process instead of running half-configured. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}
