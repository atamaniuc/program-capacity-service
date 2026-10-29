import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { serviceUnavailableProblem, unauthorizedProblem } from './problem.js';

export type Scope = 'capacity:read' | 'capacity:write';

export interface Principal {
  readonly tenantId: string;
  /** Token `sub` or `client_id`, recorded as the actor of every change. */
  readonly actor: string;
  readonly scopes: ReadonlySet<string>;
}

export interface AuthOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly clockToleranceSeconds?: number;
}

/** The issuer's keys cannot be had: not the caller's fault, so 503 rather than 401. */
function isJwksUnavailable(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
    return true;
  }
  // jose reports a non-200 answer from the JWKS endpoint as a generic JOSEError.
  if (error instanceof joseErrors.JOSEError) return error.code === 'ERR_JOSE_GENERIC';
  return error instanceof TypeError && error.message === 'fetch failed';
}

/** Verifies the bearer JWT against the issuer's JWKS (cached, rotated by `jose`). */
export class JwtVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: AuthOptions) {
    this.keys = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['RS256', 'ES256'],
        clockTolerance: this.options.clockToleranceSeconds ?? 30,
        requiredClaims: ['exp'],
      });
      const tenantId = payload['tenant_id'];
      const scope = payload['scope'];
      const actor = payload.sub ?? payload['client_id'];
      if (
        typeof tenantId !== 'string' ||
        tenantId === '' ||
        typeof scope !== 'string' ||
        typeof actor !== 'string' ||
        actor === ''
      ) {
        throw unauthorizedProblem('The token lacks tenant_id, scope or sub/client_id.');
      }
      return { tenantId, actor, scopes: new Set(scope.split(' ').filter((s) => s !== '')) };
    } catch (error) {
      if (isJwksUnavailable(error)) {
        throw serviceUnavailableProblem('The token issuer keys are unavailable; retry later.');
      }
      if (error instanceof joseErrors.JOSEError) {
        throw unauthorizedProblem('The bearer token is invalid or expired.');
      }
      // Anything else is a bug or an infrastructure fault, never "invalid credentials".
      throw error;
    }
  }

  /** Authenticates an `Authorization` header value (HTTP) or `authorization` metadata (gRPC). */
  async authenticate(header: string | undefined): Promise<Principal> {
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (match?.[1] === undefined) throw unauthorizedProblem('A bearer token is required.');
    return this.verify(match[1]);
  }
}
