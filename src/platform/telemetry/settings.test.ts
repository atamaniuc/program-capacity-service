import { describe, expect, it } from 'vitest';
import { loadRuntimeSettings } from './settings.js';

describe('runtime settings retention floors', () => {
  it('NFR-11 accepts the default and larger retention windows', () => {
    const settings = loadRuntimeSettings({
      RETENTION_IDEMPOTENCY_SECONDS: '172800',
      RETENTION_INBOX_SECONDS: '864000',
    });
    expect(settings.retention.idempotencyKeyMaxAgeSeconds).toBe(172_800);
    expect(settings.retention.inboxMaxAgeSeconds).toBe(864_000);
    expect(loadRuntimeSettings({}).retention.idempotencyKeyMaxAgeSeconds).toBe(86_400);
  });

  it('NFR-11 rejects an idempotency retention below 24 hours', () => {
    expect(() => loadRuntimeSettings({ RETENTION_IDEMPOTENCY_SECONDS: '3600' })).toThrow(
      /RETENTION_IDEMPOTENCY_SECONDS must be at least 86400/,
    );
  });

  it('NFR-11 rejects an inbox retention below 7 days', () => {
    expect(() => loadRuntimeSettings({ RETENTION_INBOX_SECONDS: '86400' })).toThrow(
      /RETENTION_INBOX_SECONDS must be at least 604800/,
    );
  });
});
