import { describe, expect, it } from 'vitest';
import { SERVICE_NAME } from '#src/service-name.js';

describe('payments-mock workspace', () => {
  it('WS-01 payments-mock runs its own unit project', () => {
    expect(SERVICE_NAME).toBe('payments-mock');
  });
});
