import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  'timeout-minutes'?: number;
  steps: Step[];
}

const workflow = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, Job> };
const jobs = workflow.jobs;
const runs = (job: Job) => job.steps.map((s) => s.run?.trim()).filter((r) => r !== undefined);
const makeTargets = (job: Job) => runs(job).filter((r) => r.startsWith('make '));

describe('CI workflow (lane 0006 T23)', () => {
  it('T23 runs make helm-check in a job of its own, with helm pinned', () => {
    const charts = jobs['charts'];
    expect(charts).toBeDefined();
    expect(makeTargets(charts as Job)).toEqual(['make helm-check']);
    const helm = (charts as Job).steps.find((s) => s.uses?.startsWith('azure/setup-helm@'));
    expect(helm?.uses).toMatch(/@v\d+\.\d+\.\d+$/);
    expect(String(helm?.with?.['version'])).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('T23 builds the funding and payments-mock images from their Dockerfiles', () => {
    const image = runs(jobs['image'] as Job);
    expect(image).toContain('docker build -f services/funding/Dockerfile -t funding-service:ci .');
    expect(image).toContain(
      'docker build -f services/payments-mock/Dockerfile -t payments-mock:ci .',
    );
  });

  it('T23 kind job runs exactly make kind-up then make kind-smoke, only for microservices', () => {
    const kind = jobs['kind'] as Job;
    expect(makeTargets(kind)).toEqual(['make kind-up', 'make kind-smoke']);
    expect(kind.if).toContain("github.ref == 'refs/heads/microservices'");
    expect(kind.if).toContain("github.base_ref == 'microservices'");
    expect(kind['timeout-minutes']).toBeGreaterThanOrEqual(20);
    expect(kind['timeout-minutes']).toBeLessThanOrEqual(45);
  });

  it('T23 kind job only installs kind: the cluster, kubeconfig and ports come from make', () => {
    const kind = jobs['kind'] as Job;
    const action = kind.steps.find((s) => s.uses?.startsWith('helm/kind-action@'));
    expect(action?.uses).toMatch(/@v\d+\.\d+\.\d+$/);
    expect(action?.with?.['install_only']).toBe(true);
    for (const input of ['config', 'kubeconfig', 'cluster_name', 'registry'])
      expect(action?.with, input).not.toHaveProperty(input);
    const text = read('.github/workflows/ci.yml');
    expect(text).not.toMatch(/extraPortMappings|~\/\.kube/);
  });

  it('T23 kind job uploads kubectl state as an artifact when it fails, using the .kind kubeconfig', () => {
    const kind = jobs['kind'] as Job;
    const collect = kind.steps.find((s) => s.name === 'Collect cluster state');
    expect(collect?.if).toBe('failure()');
    expect(collect?.run).toContain('--kubeconfig .kind/kubeconfig --context kind-finverity-ms');
    expect(collect?.run).toMatch(/get pods,svc,events/);
    expect(collect?.run).toMatch(/logs --all-containers/);
    const upload = kind.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.uses).toMatch(/@v\d+\.\d+\.\d+$/);
    expect(upload?.if).toBe('failure()');
    expect(upload?.with?.['path']).toBe('kind-logs');
  });

  it('T23 the make targets the workflow runs exist in the Makefile', () => {
    const makefile = read('Makefile');
    for (const target of ['helm-check', 'kind-up', 'kind-smoke'])
      expect(makefile, target).toMatch(new RegExp(`^${target}:`, 'm'));
  });

  it('T23 the service Dockerfiles the workflow builds exist', () => {
    for (const path of ['services/funding/Dockerfile', 'services/payments-mock/Dockerfile'])
      expect(read(path)).toContain('FROM node:24');
  });
});
