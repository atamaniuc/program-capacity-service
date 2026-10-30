import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));

interface Doc {
  kind: string;
  spec?: Record<string, unknown>;
}

const ISSUER = 'http://oauth.finverity-ms.svc.cluster.local:8080/default';

interface Named extends Doc {
  metadata?: { name?: string };
}

function render(): Doc[] {
  const out = execFileSync(
    'helm',
    ['template', 'gateway', 'deploy/helm/gateway', '--set-string', `issuer=${ISSUER}`],
    { cwd: root, encoding: 'utf8' },
  );
  return parseAllDocuments(out)
    .map((d) => d.toJS() as Doc | null)
    .filter((d): d is Doc => d !== null && typeof d === 'object');
}

describe('gateway chart (ADR 029)', () => {
  const docs = render();
  const ofKind = (kind: string) => docs.filter((d) => d.kind === kind);

  it('GW-05 holds no GRPCRoute, TCPRoute or TLSRoute', () => {
    const kinds = docs.map((d) => d.kind);
    for (const forbidden of ['GRPCRoute', 'TCPRoute', 'TLSRoute', 'UDPRoute'])
      expect(kinds).not.toContain(forbidden);
    expect(ofKind('HTTPRoute')).toHaveLength(2);
  });

  it('GW-05 has one Gateway with one HTTP listener', () => {
    const gateways = ofKind('Gateway');
    expect(gateways).toHaveLength(1);
    const listeners = gateways[0]?.spec?.['listeners'] as { protocol: string }[];
    expect(listeners).toHaveLength(1);
    expect(listeners[0]?.protocol).toBe('HTTP');
  });

  it('GW-05 routes name only HTTP ports, never gRPC 50051 or an ops port', () => {
    const refs = ofKind('HTTPRoute').flatMap((route) =>
      (route.spec?.['rules'] as { backendRefs: { name: string; port: number }[] }[]).flatMap(
        (rule) => rule.backendRefs,
      ),
    );
    expect(refs.map((r) => `${r.name}:${r.port}`).sort()).toEqual([
      'capacity-api:3000',
      'funding-api:3100',
    ]);
    for (const ref of refs) expect([50051, 9464]).not.toContain(ref.port);
  });

  it('GW-05 routes carry no hostnames and match the two public prefixes', () => {
    const routes = ofKind('HTTPRoute');
    for (const route of routes) expect(route.spec).not.toHaveProperty('hostnames');
    const prefixes = routes.flatMap((r) =>
      (r.spec?.['rules'] as { matches: { path: { type: string; value: string } }[] }[]).flatMap(
        (rule) => rule.matches.map((m) => `${m.path.type} ${m.path.value}`),
      ),
    );
    expect(prefixes.sort()).toEqual(['PathPrefix /v1/funding-requests', 'PathPrefix /v1/programs']);
  });

  const targetOf = (doc: Doc) =>
    (doc.spec?.['targetRefs'] as { kind: string; name: string }[]).map(
      (t) => `${t.kind}/${t.name}`,
    );

  it("GW-02 (static) one SecurityPolicy per route checks that route's audience, the one issuer and maps the tenant", () => {
    const audienceOf: Record<string, string> = {
      capacity: 'capacity-service',
      funding: 'funding-service',
    };
    const routes = ofKind('HTTPRoute') as Named[];
    const policies = ofKind('SecurityPolicy') as Named[];
    expect(policies).toHaveLength(routes.length);
    for (const route of routes) {
      const name = route.metadata?.name ?? '';
      const matching = policies.filter((p) => targetOf(p).includes(`HTTPRoute/${name}`));
      expect(matching).toHaveLength(1);
      const jwt = matching[0]?.spec?.['jwt'] as {
        providers: {
          issuer: string;
          audiences: string[];
          remoteJWKS: { cacheDuration: string; backendRefs: unknown[] };
          claimToHeaders: { claim: string; header: string }[];
        }[];
      };
      expect(jwt.providers).toHaveLength(1);
      const provider = jwt.providers[0];
      expect(provider?.issuer).toBe(ISSUER);
      expect(provider?.audiences).toEqual([audienceOf[name]]);
      expect(provider?.remoteJWKS.cacheDuration).toBe('30s');
      expect(provider?.remoteJWKS.backendRefs.length).toBeGreaterThan(0);
      expect(provider?.claimToHeaders).toEqual([{ claim: 'tenant_id', header: 'x-tenant-id' }]);
    }
  });

  it('GW-04 (static) the edge removes a client-sent x-tenant-id before any filter', () => {
    const policies = ofKind('ClientTrafficPolicy');
    expect(policies).toHaveLength(1);
    expect(targetOf(policies[0] as Doc)).toEqual(['Gateway/edge']);
    const headers = policies[0]?.spec?.['headers'] as { earlyRequestHeaders: { remove: string[] } };
    expect(headers.earlyRequestHeaders.remove).toContain('x-tenant-id');
  });

  it('GW-04 (static) each route has a local per-tenant limit keyed on x-tenant-id (Distinct), no Redis', () => {
    const routes = (ofKind('HTTPRoute') as Named[]).map((r) => `HTTPRoute/${r.metadata?.name}`);
    const policies = ofKind('BackendTrafficPolicy');
    expect(policies.flatMap(targetOf).sort()).toEqual(routes.sort());
    for (const policy of policies) {
      const limit = policy.spec?.['rateLimit'] as {
        type: string;
        local: { rules: { clientSelectors: { headers: { name: string; type: string }[] }[] }[] };
      };
      expect(limit.type).toBe('Local');
      const rules = limit.local.rules;
      expect(rules).toHaveLength(1);
      expect(rules[0]?.clientSelectors[0]?.headers).toEqual([
        { name: 'x-tenant-id', type: 'Distinct' },
      ]);
    }
  });
});
