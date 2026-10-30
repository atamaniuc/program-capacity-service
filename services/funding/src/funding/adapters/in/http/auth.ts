import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpProblem } from './problem.js';

export type Scope = 'funding:read' | 'funding:write';

export interface Principal {
  readonly tenantId: string;
  /** Token `sub` or `client_id`. */
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
  if (error instanceof joseErrors.JOSEError) return error.code === 'ERR_JOSE_GENERIC';
  return error instanceof TypeError && error.message === 'fetch failed';
}

/** Verifies the bearer JWT against the issuer's JWKS (cached, rotated by `jose`). */
export class JwtVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: AuthOptions) {
    this.keys = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  async authenticate(header: string | undefined): Promise<Principal> {
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (match?.[1] === undefined)
      throw HttpProblem.of('unauthorized', 'A bearer token is required.');
    try {
      const { payload } = await jwtVerify(match[1], this.keys, {
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
        throw HttpProblem.of('unauthorized', 'The token lacks tenant_id, scope or sub/client_id.');
      }
      return { tenantId, actor, scopes: new Set(scope.split(' ').filter((s) => s !== '')) };
    } catch (error) {
      if (error instanceof HttpProblem) throw error;
      if (isJwksUnavailable(error)) {
        throw HttpProblem.of(
          'service-unavailable',
          'The token issuer keys are unavailable; retry later.',
        );
      }
      if (error instanceof joseErrors.JOSEError) {
        throw HttpProblem.of('unauthorized', 'The bearer token is invalid or expired.');
      }
      throw error;
    }
  }
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.has(scope)) {
    throw HttpProblem.of('forbidden', `The token lacks the ${scope} scope.`);
  }
}
