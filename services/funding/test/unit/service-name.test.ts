import { describe, expect, it } from 'vitest';
import { SERVICE_NAME } from '#src/service-name.js';

describe('funding workspace', () => {
  it('WS-01 funding runs its own unit project', () => {
    expect(SERVICE_NAME).toBe('funding-service');
  });
});
