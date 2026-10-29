import { z } from 'zod';

const DURATION_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'must be a duration such as 15m, 24h or 7d')
  .transform((value) => {
    const unit = value.slice(-1) as keyof typeof DURATION_UNIT_SECONDS;
    return Number.parseInt(value.slice(0, -1), 10) * DURATION_UNIT_SECONDS[unit];
  });

const port = z.coerce.number().int().min(1).max(65535);

const schema = z.object({
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  HTTP_PORT: port.default(3000),
  /** Internal gRPC port of the api role (ADR 024); the worker role never binds it. */
  GRPC_PORT: port.default(50051),
  OPS_PORT: port.default(9464),
  DATABASE_URL: z
    .string()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// connection URL'),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((broker) => broker.trim())),
  OAUTH_ISSUER: z.url(),
  OAUTH_AUDIENCE: z.string().min(1),
  OAUTH_JWKS_URL: z.url(),
  /** Token endpoint shown by the interactive API docs; local development only. */
  OAUTH_TOKEN_URL: z.url().optional(),
  /** Browser origins allowed to call `/v1` (the API docs page); empty disables CORS. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    )
    .pipe(z.array(z.url())),
  FX_MAX_AGE: duration.default(24 * 3600),
  RECON_TOLERANCE_MINOR: z.coerce.number().int().min(0).default(1),
  RECON_MAX_RESERVATIONS: z.coerce.number().int().min(1).default(50_000),
  RECON_MODE: z.enum(['HOLD', 'RELEASE']).default('HOLD'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppRole = 'api' | 'worker' | 'all';

export interface Config {
  readonly appRole: AppRole;
  readonly httpPort: number;
  readonly grpcPort: number;
  readonly opsPort: number;
  readonly databaseUrl: string;
  readonly kafkaBrokers: readonly string[];
  readonly oauthIssuer: string;
  readonly oauthAudience: string;
  readonly oauthJwksUrl: string;
  readonly oauthTokenUrl: string | undefined;
  readonly corsOrigins: readonly string[];
  readonly fxMaxAgeSeconds: number;
  readonly reconToleranceMinor: number;
  readonly reconMaxReservations: number;
  readonly reconMode: 'HOLD' | 'RELEASE';
  readonly logLevel: string;
}

/** Names the invalid fields and why, never the values: configuration may hold secrets. */
export class ConfigError extends Error {
  constructor(
    readonly fields: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // zod issue messages describe the expected shape, never the received value.
    const lines = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(
      parsed.error.issues.map((issue) => issue.path.join('.')),
      `Invalid configuration, fix these environment variables: ${lines.join('; ')}`,
    );
  }
  const data = parsed.data;
  return {
    appRole: data.APP_ROLE,
    httpPort: data.HTTP_PORT,
    grpcPort: data.GRPC_PORT,
    opsPort: data.OPS_PORT,
    databaseUrl: data.DATABASE_URL,
    kafkaBrokers: data.KAFKA_BROKERS,
    oauthIssuer: data.OAUTH_ISSUER,
    oauthAudience: data.OAUTH_AUDIENCE,
    oauthJwksUrl: data.OAUTH_JWKS_URL,
    oauthTokenUrl: data.OAUTH_TOKEN_URL,
    corsOrigins: data.CORS_ORIGINS,
    fxMaxAgeSeconds: data.FX_MAX_AGE,
    reconToleranceMinor: data.RECON_TOLERANCE_MINOR,
    reconMaxReservations: data.RECON_MAX_RESERVATIONS,
    reconMode: data.RECON_MODE,
    logLevel: data.LOG_LEVEL,
  };
}
