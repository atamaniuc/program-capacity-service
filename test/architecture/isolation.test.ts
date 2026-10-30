import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The host ports of `main`'s stack (ADR 027): the branch must never publish or default to one. */
const MAIN_PORTS = [5432, 29092, 8081, 8080, 3000, 9464, 9465, 9090, 3001, 16686, 4318];

/** Resolves `${VAR:-default}` to the default: the test checks what a clean checkout gets. */
const withDefaults = (text: string) => text.replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, '$1');

interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: string[];
  environment?: Record<string, string | number>;
}
const compose = parse(read('deploy/compose.yaml')) as {
  name: string;
  services: Record<string, ComposeService>;
};
const resolved = parse(withDefaults(read('deploy/compose.yaml'))) as typeof compose;

/** Host side of a `host:container` mapping. */
const hostPort = (mapping: string) => Number(String(mapping).split(':')[0]);

function files(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    return statSync(join(root, path)).isDirectory() ? files(path) : [path];
  });
}

/** A main port used as an address (`:3000`, `=9464`), not as a number inside `3000000.00`. */
const mainPortAddress = new RegExp(`[:=](${MAIN_PORTS.join('|')})(?!\\d|\\.\\d)`);

describe('side-by-side isolation from main', () => {
  it('MS-01 publishes Kafka UI on HOST_PORT_KAFKA_UI, default 18080', () => {
    expect(compose.services['kafka-ui']?.ports).toEqual(['${HOST_PORT_KAFKA_UI:-18080}:8080']);
    expect(resolved.services['kafka-ui']?.ports).toEqual(['18080:8080']);
  });

  it('MS-01 uses the compose project program-capacity-ms', () => {
    expect(compose.name).toBe('program-capacity-ms');
  });

  it('MS-01 publishes no host port of main', () => {
    const published = Object.values(resolved.services).flatMap((s) =>
      (s.ports ?? []).map(hostPort),
    );
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((p) => MAIN_PORTS.includes(p))).toEqual([]);
  });

  it('MS-01 tags every built image :ms-local', () => {
    const built = Object.entries(compose.services).filter(([, s]) => s.build !== undefined);
    const anchors = read('deploy/compose.yaml').match(/image: program-capacity-service:\S+/g);
    expect(anchors).toEqual(['image: program-capacity-service:ms-local']);
    for (const [, service] of built) expect(service.image ?? '').not.toContain(':local');
  });

  it('MS-01 reads every host port from an environment variable', () => {
    const text = read('deploy/compose.yaml');
    const mappings = [...text.matchAll(/^\s+- '([^']+:\d+)'$/gm)].map((m) => m[1] ?? '');
    expect(mappings.length).toBeGreaterThan(0);
    for (const mapping of mappings)
      expect(mapping).toMatch(/^(127\.0\.0\.1:)?\$\{HOST_PORT_[A-Z_]+:-\d+\}:/);
  });

  it('MS-01 advertises the shifted Kafka host port', () => {
    const env = resolved.services['kafka']?.environment ?? {};
    expect(String(env['KAFKA_ADVERTISED_LISTENERS'])).toContain('EXTERNAL://localhost:39092');
    expect(String(env['KAFKA_LISTENERS'])).toContain('EXTERNAL://:39092');
    expect(resolved.services['kafka']?.ports).toEqual(['39092:39092']);
  });

  it('MS-01 makes the OAuth issuer, token URL and CORS follow the shifted ports', () => {
    const text = withDefaults(read('deploy/compose.yaml'));
    expect(text).toContain('OAUTH_ISSUER: http://localhost:18081/default');
    expect(text).toContain('OAUTH_TOKEN_URL: http://localhost:18081/default/token');
    expect(text).toContain('CORS_ORIGINS: http://localhost:19464,http://127.0.0.1:19464');
  });

  it('MS-01 keeps main ports out of every script default', () => {
    const scanned = [
      'Makefile',
      '.env.example',
      'package.json',
      'tools/doctor.sh',
      ...files('tools').filter((f) => /\.(ts|js|sh|bash)$/.test(f)),
      ...files('db/seeds'),
    ];
    const leaks = scanned.flatMap((file) =>
      read(file)
        .split('\n')
        .map((line, index) => ({ at: `${file}:${index + 1}`, line }))
        .filter(({ line }) => mainPortAddress.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(leaks).toEqual([]);
  });

  it('MS-01 keeps main ports out of the local-stack docs and the generated AsyncAPI', () => {
    const hostAddress = new RegExp(`(localhost|127\\.0\\.0\\.1):(${MAIN_PORTS.join('|')})(?!\\d)`);
    const leaks = [
      'docs/local-stack.md',
      'docs/qa.md',
      'docs/runbook.md',
      'contracts/asyncapi.yaml',
    ].flatMap((file) =>
      read(file)
        .split('\n')
        .map((line, index) => ({ at: `${file}:${index + 1}`, line }))
        .filter(({ line }) => hostAddress.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(leaks).toEqual([]);
    expect(read('contracts/asyncapi.yaml')).toContain('host: localhost:39092');
  });

  it('MS-01 names only cluster finverity-ms with .kind/kubeconfig for kind', () => {
    const makefile = read('Makefile');
    expect(makefile).toMatch(/^KIND_CLUSTER\s*:=\s*finverity-ms$/m);
    expect(makefile).toMatch(/^KUBECONFIG_FILE\s*:=\s*\.kind\/kubeconfig$/m);
    const kindLines = makefile
      .split('\n')
      .filter((l) => /^\t.*\bkind (create|delete|load|export|get)\b/.test(l));
    for (const line of kindLines) {
      expect(line).toContain('$(KIND_CLUSTER)');
      expect(line).not.toMatch(/--name\s+(?!\$\(KIND_CLUSTER\))/);
    }
    expect(read('.gitignore').split('\n')).toContain('.kind/');
  });

  it('MS-01 passes the same ports to compose, Makefile and scripts', () => {
    const makefile = read('Makefile');
    for (const [name, value] of [
      ['HOST_PORT_POSTGRES', 15432],
      ['HOST_PORT_KAFKA', 39092],
      ['HOST_PORT_OAUTH', 18081],
      ['HOST_PORT_API', 13000],
      ['HOST_PORT_API_GRPC', 60051],
      ['HOST_PORT_API_OPS', 19464],
      ['HOST_PORT_WORKER_OPS', 19465],
      ['HOST_PORT_KAFKA_UI', 18080],
    ] as const) {
      expect(makefile).toMatch(new RegExp(`^export ${name} \\?= ${value}$`, 'm'));
    }
    expect(read('deploy/compose.yaml')).toContain('HOST_PORT_API:-13000');
  });
});

describe('make doctor on the shifted ports', () => {
  const doctor = read('tools/doctor.sh');

  it('MS-03 checks the branch ports, not main ports', () => {
    for (const port of [13000, 15432, 18081, 19464, 19465, 39092]) {
      expect(doctor).toContain(String(port));
    }
  });

  it('MS-03 warns, never fails, on missing kind, helm or kubectl', () => {
    expect(doctor).toContain('for tool in kind helm kubectl; do');
    expect(doctor).toContain('warn "$tool"');
    expect(doctor).not.toMatch(/fail "?\$?\{?(tool|kind|helm|kubectl)\b/);
  });
});

describe('kind targets (ADR 026)', () => {
  const makefile = read('Makefile');
  const recipe = (target: string) => {
    const start = makefile.indexOf(`\n${target}:`);
    expect(start).toBeGreaterThan(-1);
    const rest = makefile
      .slice(start + 1)
      .split('\n')
      .slice(1);
    const end = rest.findIndex((l) => l !== '' && !l.startsWith('\t') && !l.startsWith(' '));
    return rest.slice(0, end === -1 ? undefined : end).join('\n');
  };

  it('K8-04 deletes only cluster finverity-ms, with a constant name', () => {
    expect(makefile).toMatch(/^KIND_CLUSTER := finverity-ms$/m);
    const down = recipe('kind-down');
    const deletes = down.split('\n').filter((l) => /\bkind delete\b/.test(l));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain('kind delete cluster --name $(KIND_CLUSTER)');
    expect(deletes[0]).toContain('--kubeconfig $(KUBECONFIG_FILE)');
    expect(down).not.toMatch(/--all|delete clusters|\.kube\/config/);
  });

  it('K8-04 passes the kubeconfig file and context to every kubectl and helm call', () => {
    expect(makefile).toMatch(
      /^KUBECTL := kubectl --kubeconfig \$\(KUBECONFIG_FILE\) --context kind-\$\(KIND_CLUSTER\)/m,
    );
    expect(makefile).toMatch(
      /^HELM := helm --kubeconfig \$\(KUBECONFIG_FILE\) --kube-context kind-\$\(KIND_CLUSTER\)/m,
    );
    const bare = makefile
      .split('\n')
      .filter(
        (l) =>
          /^\t/.test(l) &&
          /(^|[\s;&(])(kubectl|helm) /.test(l) &&
          !/helm-check|\$\((KUBECTL|HELM)\)/.test(l),
      );
    expect(bare).toEqual([]);
    expect(makefile).not.toContain('~/.kube');
  });

  it('K8-04 passes --kubeconfig to every kind create, export and delete', () => {
    const calls = makefile
      .split('\n')
      .filter((l) => /^\t/.test(l) && /\bkind (create|export|delete)\b/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call).toContain('--kubeconfig $(KUBECONFIG_FILE)');
  });

  it('K8-04 gives capacity, funding and gateway the one cluster issuer, and funding its token URL', () => {
    expect(makefile).toMatch(/^KIND_OAUTH_ISSUER := .*svc\.cluster\.local:/m);
    const up = recipe('kind-up');
    const release = (name: string) =>
      up.match(
        new RegExp(
          `upgrade --install ${name} deploy/helm/${name}[^@]*?(?=\\n\\t(?:@|\\$\\(|else)|$)`,
        ),
      )?.[0] ?? '';
    for (const name of ['capacity', 'funding'])
      expect(release(name)).toContain('--set-string oauth.issuer=$(KIND_OAUTH_ISSUER)');
    expect(release('funding')).toContain('--set-string oauth.tokenUrl=$(KIND_OAUTH_ISSUER)/token');
    expect(release('gateway')).toContain('--set-string issuer=$(KIND_OAUTH_ISSUER)');
  });

  it('K8-02 kind-up builds, loads and installs all three images, each from its own Dockerfile', () => {
    const up = recipe('kind-up');
    for (const [image, dockerfile] of [
      ['program-capacity-service', 'Dockerfile'],
      ['funding-service', 'services/funding/Dockerfile'],
      ['payments-mock', 'services/payments-mock/Dockerfile'],
    ] as const) {
      expect(read(dockerfile)).toContain('FROM node:24');
      const build =
        dockerfile === 'Dockerfile' ? 'docker build -t' : `docker build -f ${dockerfile} -t`;
      expect(up).toContain(`${build} ${image}:ms-local .`);
      expect(up).toMatch(
        new RegExp(`kind load docker-image --name \\$\\(KIND_CLUSTER\\)[^\\n]*${image}:ms-local`),
      );
    }
    expect(up).toContain('--set paymentsMock.enabled=true');
    expect(up).toContain('upgrade --install funding deploy/helm/funding');
  });

  it('K8-04 forwards only host ports 23000-23099 and the cluster has no host port mapping', () => {
    const forwards = [...recipe('kind-forward').matchAll(/(\d{5}):/g)].map((m) => Number(m[1]));
    expect(forwards.length).toBeGreaterThan(0);
    for (const port of forwards) {
      expect(port).toBeGreaterThanOrEqual(23000);
      expect(port).toBeLessThanOrEqual(23099);
    }
    const cluster = parse(read('deploy/kind/cluster.yaml')) as {
      name: string;
      nodes: { extraPortMappings?: unknown }[];
    };
    expect(cluster.name).toBe('finverity-ms');
    for (const node of cluster.nodes) expect(node.extraPortMappings).toBeUndefined();
  });
});

describe('mock OAuth2 config copies (ADR 026)', () => {
  const compose = 'deploy/oauth/config.json';
  const chart = 'deploy/helm/local-infra/files/oauth-config.json';

  it('K8-01 the chart carries the same mock OAuth2 config as compose, byte for byte', () => {
    expect(read(chart)).toBe(read(compose));
  });

  it('K8-01 the config maps a funding: scope to the funding audience and keeps the capacity default', () => {
    const config = JSON.parse(read(chart)) as {
      tokenCallbacks: {
        requestMappings: { requestParam: string; match: string; claims: { aud: string[] } }[];
      }[];
    };
    const mappings = config.tokenCallbacks[0]?.requestMappings ?? [];
    const funding = mappings.find(
      (m) => m.requestParam === 'scope' && m.match.includes('funding:'),
    );
    expect(funding?.claims.aud).toEqual(['funding-service']);
    expect(mappings.at(-1)).toMatchObject({
      requestParam: 'client_id',
      match: '*',
      claims: { aud: ['capacity-service'] },
    });
  });
});
