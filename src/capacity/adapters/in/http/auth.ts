import {
  SetMetadata,
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { forbidden, unauthorized } from './problem.js';

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

export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
const SCOPE_KEY = 'capacity:scope';

export const RequireScope = (scope: Scope): MethodDecorator => SetMetadata(SCOPE_KEY, scope);

type AuthedRequest = Request & { principal?: Principal };

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (principal === undefined) throw unauthorized('Authentication is required.');
    return principal;
  },
);

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
      if (error instanceof joseErrors.JOSEError || error instanceof TypeError) {
        throw unauthorized('The bearer token is invalid or expired.');
      }
      throw error;
    }
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly verifier: JwtVerifier;

  constructor(
    @Inject(AUTH_OPTIONS) options: AuthOptions,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
    this.verifier = new JwtVerifier(options);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    const match = header === undefined ? null : /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
    if (match?.[1] === undefined) throw unauthorized('A bearer token is required.');
    const principal = await this.verifier.verify(match[1]);
    const required = this.reflector.get<Scope | undefined>(SCOPE_KEY, context.getHandler());
    if (required !== undefined && !principal.scopes.has(required)) {
      throw forbidden(`The token lacks the ${required} scope.`);
    }
    request.principal = principal;
    return true;
  }
}
