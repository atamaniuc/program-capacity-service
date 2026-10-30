import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TenantTokenProvider } from '../../src/funding/adapters/out/oauth/token-provider.js';

interface Seen {
  form: URLSearchParams;
  host: string | undefined;
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) =>
    server === undefined ? resolve() : server.close(() => resolve()),
  );
  server = undefined;
});

async function issuer(expiresIn = 3600): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
        host: request.headers.host,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ access_token: `token-${seen.length.toString()}`, expires_in: expiresIn }),
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}/token`,
    seen,
  };
}

const provider = (tokenUrl: string, extra: { issuerHost?: string; now?: () => number } = {}) =>
  new TenantTokenProvider({
    tokenUrl,
    clientIdPrefix: 'funding-service',
    clientSecret: 's',
    scope: 'capacity:write',
    ...extra,
  });

describe('tenant token provider (review m4)', () => {
  it('FS-03 the token request names the per-tenant client, the scope and the tenant_id the claim comes from', async () => {
    const { url, seen } = await issuer();
    await provider(url).tokenFor('bank-a');
    const form = seen[0]?.form;
    expect(form?.get('grant_type')).toBe('client_credentials');
    expect(form?.get('client_id')).toBe('funding-service.bank-a');
    expect(form?.get('scope')).toBe('capacity:write');
    expect(form?.get('tenant_id')).toBe('bank-a');
  });

  it('FS-03 the issuer Host is sent when configured (mock-oauth2-server derives iss from it)', async () => {
    const { url, seen } = await issuer();
    await provider(url, { issuerHost: 'localhost:18081' }).tokenFor('bank-a');
    expect(seen[0]?.host).toBe('localhost:18081');
  });

  it('FS-03 one token per tenant is cached, concurrent callers share one request, tenants never share', async () => {
    const { url, seen } = await issuer();
    const tokens = provider(url);
    const [a1, a2] = await Promise.all([tokens.tokenFor('bank-a'), tokens.tokenFor('bank-a')]);
    expect(a1).toBe(a2);
    expect(await tokens.tokenFor('bank-a')).toBe(a1);
    expect(await tokens.tokenFor('bank-b')).not.toBe(a1);
    expect(seen).toHaveLength(2);
  });

  it('FS-03 a token near expiry or invalidated is fetched again', async () => {
    const { url, seen } = await issuer(60);
    let now = 1_000_000;
    const tokens = provider(url, { now: () => now });
    await tokens.tokenFor('bank-a');
    now += 40_000; // 20 s left, inside the 30 s skew
    await tokens.tokenFor('bank-a');
    expect(seen).toHaveLength(2);
    tokens.invalidate('bank-a');
    await tokens.tokenFor('bank-a');
    expect(seen).toHaveLength(3);
  });
});
