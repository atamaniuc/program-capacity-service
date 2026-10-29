import { status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { GRPC_STATUS, PROBLEM_MAP, TRANSPORT_PROBLEM_TYPES } from '../boundary/problem.js';

describe('GR-02 hand-numbered gRPC codes', () => {
  it('GR-02 keeps every GRPC_STATUS number equal to the @grpc/grpc-js status of the same name', () => {
    for (const [name, number] of Object.entries(GRPC_STATUS)) {
      expect(status[name as keyof typeof status], name).toBe(number);
    }
  });

  it('GR-02 maps every problem type to a code that exists in @grpc/grpc-js', () => {
    const known = new Set<number>(Object.values(status).filter((v) => typeof v === 'number'));
    for (const type of TRANSPORT_PROBLEM_TYPES)
      expect(known.has(PROBLEM_MAP[type].grpc), type).toBe(true);
  });
});
