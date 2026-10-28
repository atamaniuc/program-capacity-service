import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/layer-leaks', import.meta.url));
const depcruise = `${root}node_modules/.bin/depcruise`;
const config = `${root}.dependency-cruiser.cjs`;

function run(cwd: string) {
  const result = spawnSync(depcruise, ['src', '--config', config, '--output-type', 'err'], {
    cwd,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('layer rules', () => {
  const leaks = run(fixture);

  it('SK-02 fails when the domain imports @nestjs/common and names the rule', () => {
    expect(leaks.status).not.toBe(0);
    expect(leaks.output).toContain('domain-imports-only-domain');
    expect(leaks.output).toContain('src/capacity/domain/leaky.ts');
  });

  it('SK-02 fails when application imports an adapter', () => {
    expect(leaks.output).toContain('application-imports-no-adapter');
  });

  it('SK-02 fails when one adapter imports another', () => {
    expect(leaks.output).toContain('adapters-do-not-import-each-other');
  });

  it('SK-02 fails when one use-case slice imports another', () => {
    expect(leaks.output).toContain('slices-do-not-import-each-other');
  });

  it('SK-02 passes on the real source tree', () => {
    const real = run(root);
    expect(real.output).not.toContain('error');
    expect(real.status).toBe(0);
    // dependency-cruiser parses the whole tree in a child process; 5 s is too tight on a busy machine.
  }, 30_000);
});
