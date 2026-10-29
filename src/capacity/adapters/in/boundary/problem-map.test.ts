import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES, problem } from '#src/capacity/application/shared/problem.js';
import {
  GRPC_STATUS,
  PROBLEM_MAP,
  STORED_PROBLEM_TYPES,
  TRANSPORT_PROBLEM_TYPES,
  type TransportProblemType,
} from './problem.js';

const dir = join(import.meta.dirname);

/** ADR 024, "Status mapping". */
const ADR_024: Record<TransportProblemType, [number, keyof typeof GRPC_STATUS]> = {
  'validation-error': [400, 'INVALID_ARGUMENT'],
  unauthorized: [401, 'UNAUTHENTICATED'],
  forbidden: [403, 'PERMISSION_DENIED'],
  'not-found': [404, 'NOT_FOUND'],
  'reservation-conflict': [409, 'ALREADY_EXISTS'],
  'insufficient-capacity': [422, 'FAILED_PRECONDITION'],
  'program-over-limit': [422, 'FAILED_PRECONDITION'],
  'program-suspended': [422, 'FAILED_PRECONDITION'],
  'fx-rate-unavailable': [422, 'FAILED_PRECONDITION'],
  'idempotency-key-mismatch': [422, 'FAILED_PRECONDITION'],
  'release-ref-mismatch': [422, 'FAILED_PRECONDITION'],
  'release-exceeds-remaining': [422, 'FAILED_PRECONDITION'],
  'payload-too-large': [413, 'RESOURCE_EXHAUSTED'],
  'service-unavailable': [503, 'UNAVAILABLE'],
  'internal-error': [500, 'INTERNAL'],
};

describe('GR-02 one problem table for both transports', () => {
  it('GR-02 maps every transport problem type to exactly the HTTP status and gRPC code of ADR 024', () => {
    expect(Object.keys(PROBLEM_MAP).sort()).toEqual([...TRANSPORT_PROBLEM_TYPES].sort());
    expect(Object.keys(ADR_024).sort()).toEqual([...TRANSPORT_PROBLEM_TYPES].sort());
    for (const type of TRANSPORT_PROBLEM_TYPES) {
      const [http, grpc] = ADR_024[type];
      expect(PROBLEM_MAP[type].http, type).toBe(http);
      expect(PROBLEM_MAP[type].grpc, type).toBe(GRPC_STATUS[grpc]);
    }
  });

  it('GR-02 keeps the HTTP status of every business problem equal to the application catalog', () => {
    for (const type of PROBLEM_TYPES) {
      expect(PROBLEM_MAP[type].http, type).toBe(problem(type, 'x').status);
      expect(PROBLEM_MAP[type].title, type).toBe(problem(type, 'x').title);
    }
  });

  it('GR-02 maps every outcome stored under an Idempotency-Key to a definite-failure gRPC code', () => {
    // ADR 025: only these codes tell the saga "definitely failed"; anything else is "unknown".
    const definite: ReadonlySet<number> = new Set([
      GRPC_STATUS.FAILED_PRECONDITION,
      GRPC_STATUS.NOT_FOUND,
      GRPC_STATUS.ALREADY_EXISTS,
      GRPC_STATUS.INVALID_ARGUMENT,
      GRPC_STATUS.PERMISSION_DENIED,
    ]);
    expect(STORED_PROBLEM_TYPES).toContain('fx-rate-unavailable');
    expect(STORED_PROBLEM_TYPES).toContain('insufficient-capacity');
    expect(STORED_PROBLEM_TYPES).not.toContain('idempotency-key-mismatch');
    for (const type of STORED_PROBLEM_TYPES) {
      expect(definite.has(PROBLEM_MAP[type].grpc), type).toBe(true);
    }
    expect(PROBLEM_MAP['service-unavailable'].grpc).toBe(GRPC_STATUS.UNAVAILABLE);
  });

  it('GR-02 keeps the boundary free of transport libraries', () => {
    const forbidden = /from\s+['"](@nestjs\/|express|@grpc\/|#src\/capacity\/adapters\/)/;
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(forbidden);
    }
  });
});
