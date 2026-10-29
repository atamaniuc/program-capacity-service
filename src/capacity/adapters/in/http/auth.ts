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
import type { JwtVerifier } from '../boundary/auth.js';
import type { Principal, Scope } from '../boundary/auth.js';
import { forbidden, unauthorized } from './problem.js';
import { writeProblem } from './problem.filter.js';

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

/**
 * Authenticates every `/v1` request before the JSON body parser runs, so that malformed JSON,
 * oversized bodies and unknown routes answer 401 without a token (S6). The guard then only
 * checks scopes.
 */
export function createAuthMiddleware(verifier: JwtVerifier): RequestHandler {
  return (request, response, next) => {
    verifier.authenticate(request.headers.authorization).then(
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
