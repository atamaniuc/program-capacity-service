import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';

export interface TokenClaims {
  readonly tenantId?: string | undefined;
  readonly scope?: string | undefined;
  readonly sub?: string | undefined;
  readonly clientId?: string | undefined;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  readonly expiresIn?: string | number | undefined;
}

export interface TestIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  /** Signs with the served key by default; `signWithOtherKey` produces an unknown-key token. */
  sign(claims?: TokenClaims, options?: { signWithOtherKey?: boolean }): Promise<string>;
  close(): Promise<void>;
}

/** An in-process OAuth issuer: serves a JWKS for a key pair generated here and signs tokens. */
export async function startTestIssuer(audience = 'capacity-service'): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const server: Server = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issuer = `${base}/issuer`;

  return {
    issuer,
    audience,
    jwksUrl: `${base}/jwks`,
    sign: async (claims = {}, options = {}) => {
      const key: CryptoKey = options.signWithOtherKey === true ? other.privateKey : privateKey;
      const payload: Record<string, unknown> = {};
      if (claims.tenantId !== undefined) payload['tenant_id'] = claims.tenantId;
      if (claims.scope !== undefined) payload['scope'] = claims.scope;
      if (claims.clientId !== undefined) payload['client_id'] = claims.clientId;
      const jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt()
        .setIssuer(claims.issuer ?? issuer)
        .setAudience(claims.audience ?? audience)
        .setExpirationTime(claims.expiresIn ?? '5m');
      if (claims.sub !== undefined) jwt.setSubject(claims.sub);
      return jwt.sign(key);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
