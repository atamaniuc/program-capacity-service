import {
  SetMetadata,
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, RequestHandler } from 'express';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { forbidden, serviceUnavailable, unauthorized } from './problem.js';
import { writeProblem } from './problem.filter.js';

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

const SCOPE_KEY = 'capacity:scope';

export const RequireScope = (scope: Scope): MethodDecorator => SetMetadata(SCOPE_KEY, scope);

export type AuthedRequest = Request & { principal?: Principal };

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (principal === undefined) throw unauthorized('Authentication is required.');
    return principal;
  },
);

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
        throw unauthorized('The token lacks tenant_id, scope or sub/client_id.');
      }
      return { tenantId, actor, scopes: new Set(scope.split(' ').filter((s) => s !== '')) };
    } catch (error) {
      if (isJwksUnavailable(error)) {
        throw serviceUnavailable('The token issuer keys are unavailable; retry later.');
      }
      if (error instanceof joseErrors.JOSEError) {
        throw unauthorized('The bearer token is invalid or expired.');
      }
      // Anything else is a bug or an infrastructure fault, never "invalid credentials".
      throw error;
    }
  }

  async authenticate(request: Request): Promise<Principal> {
    const header = request.headers.authorization;
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (match?.[1] === undefined) throw unauthorized('A bearer token is required.');
    return this.verify(match[1]);
  }
}

/**
 * Authenticates every `/v1` request before the JSON body parser runs, so that malformed JSON,
 * oversized bodies and unknown routes answer 401 without a token (S6). The guard then only
 * checks scopes.
 */
export function createAuthMiddleware(verifier: JwtVerifier): RequestHandler {
  return (request, response, next) => {
    verifier.authenticate(request).then(
      (principal) => {
        (request as AuthedRequest).principal = principal;
        next();
      },
      (error: unknown) => {
        writeProblem(response, error);
      },
    );
  };
}

/** Scope check; default-deny: a handler that declares no scope is unreachable. */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (principal === undefined) throw unauthorized('Authentication is required.');
    const required = this.reflector.get<Scope | undefined>(SCOPE_KEY, context.getHandler());
    if (required === undefined) throw forbidden('This endpoint declares no required scope.');
    if (!principal.scopes.has(required)) {
      throw forbidden(`The token lacks the ${required} scope.`);
    }
    return true;
  }
}
