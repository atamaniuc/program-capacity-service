import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));

interface Container {
  name: string;
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[] };
  };
  volumeMounts?: { name: string; mountPath: string }[];
  env?: {
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef?: { name: string; key: string } };
  }[];
}
interface Doc {
  kind: string;
  metadata?: { name?: string };
  stringData?: Record<string, string>;
  spec?: {
    template?: {
      spec?: {
        securityContext?: {
          runAsNonRoot?: boolean;
          runAsUser?: number;
          seccompProfile?: { type: string };
        };
        containers: Container[];
        volumes?: { name: string; emptyDir?: unknown }[];
      };
    };
  };
}

function render(chart: string, ...set: string[]): Doc[] {
  const args = ['template', chart, `deploy/helm/${chart}`, '--namespace', 'finverity-ms'];
  for (const value of set) args.push('--set', value);
  const out = execFileSync('helm', args, { cwd: root, encoding: 'utf8' });
  return parseAllDocuments(out)
    .map((d) => d.toJS() as Doc | null)
    .filter((d): d is Doc => d !== null && typeof d === 'object');
}

const deployments = (docs: Doc[], names: string[]) =>
  names.map((name) => {
    const found = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === name);
    expect(found, name).toBeDefined();
    return found as Doc;
  });

const workloads = [
  ...deployments(render('capacity'), ['capacity-api', 'capacity-worker']),
  ...deployments(render('funding'), ['funding-api', 'funding-worker']),
  ...deployments(render('local-infra'), ['payments-mock']),
];

describe('pod hardening (acceptance item 4)', () => {
  it.each(workloads.map((w) => [w.metadata?.name ?? '', w] as const))(
    'K8-05 %s runs non-root with the default seccomp profile and a locked-down container',
    (_name, workload) => {
      const pod = workload.spec?.template?.spec;
      expect(pod?.securityContext?.runAsNonRoot).toBe(true);
      // A numeric uid: the images run as USER node, which the kubelet cannot verify by name.
      expect(pod?.securityContext?.runAsUser).toBe(1000);
      expect(pod?.securityContext?.seccompProfile?.type).toBe('RuntimeDefault');
      for (const container of pod?.containers ?? []) {
        expect(container.securityContext?.allowPrivilegeEscalation).toBe(false);
        expect(container.securityContext?.readOnlyRootFilesystem).toBe(true);
        expect(container.securityContext?.capabilities?.drop).toEqual(['ALL']);
      }
    },
  );

  it('K8-05 capacity and funding Pods get a writable /tmp as an emptyDir', () => {
    for (const workload of workloads.filter((w) => !w.metadata?.name?.startsWith('payments'))) {
      const pod = workload.spec?.template?.spec;
      expect(pod?.volumes?.find((v) => v.name === 'tmp')?.emptyDir).toBeDefined();
      expect(pod?.containers[0]?.volumeMounts).toContainEqual({ name: 'tmp', mountPath: '/tmp' });
    }
  });
});

describe('funding client secret (acceptance item 3)', () => {
  it('K8-06 only the worker reads OAUTH_CLIENT_SECRET, from its Secret, never from the ConfigMap', () => {
    const docs = render('funding');
    const [api, worker] = deployments(docs, ['funding-api', 'funding-worker']) as [Doc, Doc];
    const fromSecret = (d: Doc) =>
      d.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === 'OAUTH_CLIENT_SECRET');
    expect(fromSecret(api)).toBeUndefined();
    expect(fromSecret(worker)?.valueFrom?.secretKeyRef).toEqual({
      name: 'funding-oauth-client',
      key: 'OAUTH_CLIENT_SECRET',
    });
    const secret = docs.find(
      (d) => d.kind === 'Secret' && d.metadata?.name === 'funding-oauth-client',
    );
    expect(secret?.stringData?.['OAUTH_CLIENT_SECRET']).toBeTruthy();
    const config = docs.find((d) => d.kind === 'ConfigMap') as
      (Doc & { data?: object }) | undefined;
    expect(Object.keys(config?.data ?? {})).not.toContain('OAUTH_CLIENT_SECRET');
  });

  it('K8-06 the chart refuses to render without a client secret', () => {
    expect(() => render('funding', 'oauth.clientSecret=')).toThrow(/oauth\.clientSecret/);
  });

  it('K8-06 compose gives the funding worker its client secret', () => {
    const compose = readFileSync(join(root, 'deploy/compose.yaml'), 'utf8');
    const start = compose.indexOf('\n  funding-worker:');
    expect(start).toBeGreaterThan(-1);
    const rest = compose.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}\S/);
    const block = end === -1 ? rest : rest.slice(0, end + 1);
    expect(block).toContain('OAUTH_CLIENT_SECRET: funding-service');
  });
});
