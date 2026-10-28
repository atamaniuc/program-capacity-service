import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RequireScope, ScopeGuard, type Principal } from './auth.js';
import { HttpProblem } from './problem.js';

class Handlers {
  @RequireScope('capacity:read')
  declared(this: void): void {}

  undeclared(this: void): void {}
}

function contextFor(handler: () => void, principal: Principal | undefined): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
}

const principal = (scopes: string[]): Principal => ({
  tenantId: 't',
  actor: 'a',
  scopes: new Set(scopes),
});

describe('ScopeGuard', () => {
  const guard = new ScopeGuard(new Reflector());
  const handlers = new Handlers();

  it('S6 denies by default a handler that declares no scope, whatever the token carries', () => {
    const ctx = contextFor(handlers.undeclared, principal(['capacity:read', 'capacity:write']));
    expect(() => guard.canActivate(ctx)).toThrow(HttpProblem);
    expect(() => guard.canActivate(ctx)).toThrow(/declares no required scope/);
    try {
      guard.canActivate(ctx);
    } catch (error) {
      expect((error as HttpProblem).status).toBe(403);
    }
  });

  it('S6 admits a declared scope, refuses a missing one with 403 and no principal with 401', () => {
    expect(guard.canActivate(contextFor(handlers.declared, principal(['capacity:read'])))).toBe(
      true,
    );
    expect(() =>
      guard.canActivate(contextFor(handlers.declared, principal(['capacity:write']))),
    ).toThrow(/lacks the capacity:read scope/);
    try {
      guard.canActivate(contextFor(handlers.declared, undefined));
      expect.unreachable();
    } catch (error) {
      expect((error as HttpProblem).status).toBe(401);
    }
  });
});
