import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Mapping {
  requestParam: string;
  match: string;
  claims: { aud: string[] };
}

const CONFIG = fileURLToPath(new URL('../../../../deploy/oauth/config.json', import.meta.url));

/**
 * mock-oauth2-server: the first mapping whose request parameter matches wins; `match` is a
 * regular expression that must cover the whole value, and a lone `*` matches anything.
 */
async function audienceFor(params: Record<string, string>): Promise<string[] | undefined> {
  const config = JSON.parse(await readFile(CONFIG, 'utf8')) as {
    tokenCallbacks: { requestMappings: Mapping[] }[];
  };
  const mappings = config.tokenCallbacks[0]?.requestMappings ?? [];
  return mappings.find((m) => {
    const value = params[m.requestParam];
    return value !== undefined && (m.match === '*' || new RegExp(`^(?:${m.match})$`).test(value));
  })?.claims.aud;
}

describe('mock OAuth2 mappings (compose)', () => {
  it('FS-02 a funding API token request (both scopes) gets the funding-service audience', async () => {
    expect(await audienceFor({ client_id: 'bank-a', scope: 'funding:write funding:read' })).toEqual(
      ['funding-service'],
    );
    expect(await audienceFor({ client_id: 'bank-a', scope: 'funding:read' })).toEqual([
      'funding-service',
    ]);
  });

  it('FS-02 a per-tenant capacity client of funding gets the capacity audience, whatever its scope', async () => {
    expect(
      await audienceFor({ client_id: 'funding-service.bank-a', scope: 'capacity:reserve' }),
    ).toEqual(['capacity-service']);
  });

  it('FS-02 a plain capacity client keeps the capacity audience', async () => {
    expect(await audienceFor({ client_id: 'bank-a', scope: 'capacity:read' })).toEqual([
      'capacity-service',
    ]);
  });
});
