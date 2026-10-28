import { describe, expect, it } from 'vitest';
import { fingerprintOf } from './fingerprint.js';
import { PROBLEM_TYPES, problem, statusOf, succeeded } from './problem.js';

describe('shared application helpers', () => {
  it('T4 fingerprints canonical JSON independent of key order', () => {
    const a = fingerprintOf({ b: [1, { y: null, x: true }], a: 'text' });
    const b = fingerprintOf({ a: 'text', b: [1, { x: true, y: null }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf({ a: 'text2', b: [] })).not.toBe(a);
  });

  it('T7 gives every problem type a title and a 4xx status', () => {
    for (const type of PROBLEM_TYPES) {
      const built = problem(type, 'detail');
      expect(built.title.length).toBeGreaterThan(0);
      expect(built.status).toBeGreaterThanOrEqual(400);
      expect(built.status).toBeLessThan(500);
      expect(statusOf({ ok: false, problem: built })).toBe(built.status);
    }
    expect(statusOf(succeeded(201, {}))).toBe(201);
  });
});
