import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));

interface Doc {
  kind: string;
  spec?: Record<string, unknown>;
}

function render(): Doc[] {
  const out = execFileSync(
    'helm',
    [
      'template',
      'gateway',
      'deploy/helm/gateway',
      '--set-string',
      'issuer=http://oauth.finverity-ms.svc.cluster.local:8080/default',
    ],
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
});
