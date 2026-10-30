import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface TokenProviderOptions {
  readonly tokenUrl: string;
  /** Client id is `<prefix>.<tenant>`: one token per tenant, never an all-tenant token (ADR 024). */
  readonly clientIdPrefix: string;
  readonly clientSecret: string;
  readonly scope: string;
  /**
   * The issuer's `Host`: mock-oauth2-server derives `iss` from the request host, so a service
   * minting tokens inside the network must send the configured issuer's host (ADR 027 trap).
   */
  readonly issuerHost?: string | undefined;
  readonly timeoutMs?: number;
  /** Refresh this long before the token expires. */
  readonly skewMs?: number;
  readonly now?: () => number;
}

interface Cached {
  readonly token: string;
  readonly expiresAt: number;
}

/** Client-credentials tokens for capacity, cached per tenant and shared by concurrent callers. */
export class TenantTokenProvider {
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly options: TokenProviderOptions) {}

  async tokenFor(tenantId: string): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && cached.expiresAt - (this.options.skewMs ?? 30_000) > now) {
      return cached.token;
    }
    const pending = this.inflight.get(tenantId);
    if (pending !== undefined) return pending;
    const fetching = this.fetchToken(tenantId).finally(() => {
      this.inflight.delete(tenantId);
    });
    this.inflight.set(tenantId, fetching);
    return fetching;
  }

  /** After an UNAUTHENTICATED answer the cached token is not trusted again. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async fetchToken(tenantId: string): Promise<string> {
    const { options } = this;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: `${options.clientIdPrefix}.${tenantId}`,
      client_secret: options.clientSecret,
      scope: options.scope,
      // The issuer mints the `tenant_id` claim from this parameter; without it the claim is the
      // literal placeholder and capacity answers NOT_FOUND for every program (review m4).
      tenant_id: tenantId,
    });
    const response = await post(
      options.tokenUrl,
      body.toString(),
      options.issuerHost,
      options.timeoutMs ?? 5_000,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`token endpoint answered ${response.status.toString()}`);
    }
    const parsed = JSON.parse(response.body) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new Error('token endpoint answered without an access_token');
    }
    const lifetimeSeconds = typeof parsed.expires_in === 'number' ? parsed.expires_in : 60;
    this.cache.set(tenantId, {
      token: parsed.access_token,
      expiresAt: (options.now ?? Date.now)() + lifetimeSeconds * 1000,
    });
    return parsed.access_token;
  }
}

/** `fetch` ignores a custom `Host`, which the issuer's `iss` depends on: use `node:http`. */
function post(
  url: string,
  body: string,
  host: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          ...(host === undefined ? {} : { host }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('token endpoint timed out'));
    });
    req.on('error', reject);
    req.end(body);
  });
}
