import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const protoDir = join(root, 'contracts/proto');
const protoFile = 'finverity/capacity/v1/capacity_service.proto';
const buf = join(root, 'node_modules/.bin/buf');

function run(command: string, args: string[]) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
}

function protoFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return protoFiles(path);
    return name.endsWith('.proto') ? [path] : [];
  });
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('GR-01 proto contract', () => {
  it('GR-01 passes buf lint (STANDARD)', () => {
    const result = run(buf, ['lint', 'contracts/proto']);
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('GR-01 declares CapacityService with Reserve, Release and GetAvailability', () => {
    const source = readFileSync(join(protoDir, protoFile), 'utf8');
    expect(source).toContain('package finverity.capacity.v1;');
    for (const rpc of ['Reserve', 'Release', 'GetAvailability']) {
      expect(source).toMatch(new RegExp(`rpc ${rpc}\\(`));
    }
    expect(source).toMatch(/enum ReserveResult[^}]*CREATED[^}]*EXISTING/s);
    expect(source).toMatch(/message Money \{\s*string value = 1;\s*string currency_code = 2;\s*\}/);
  });

  it('GR-01 has no float, double or integer money field in the package', () => {
    for (const file of protoFiles(protoDir)) {
      const code = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\b(float|double)\b/);
      expect(code, file).not.toMatch(
        /\b(u?int32|u?int64|sint32|sint64|fixed32|fixed64)\s+\w*(amount|money|value|limit|reserved|available|minor)\w*\s*=/i,
      );
    }
  });

  it('GR-01 committed stubs match a fresh buf generate', () => {
    const result = run('npx', ['tsx', 'tools/proto/generate.ts', '--check']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('GR-01 buf breaking reports a fixture that removes a field', () => {
    const base = mkdtempSync(join(tmpdir(), 'proto-base-'));
    const changed = mkdtempSync(join(tmpdir(), 'proto-changed-'));
    scratch.push(base, changed);
    for (const dir of [base, changed]) {
      cpSync(join(protoDir, 'buf.yaml'), join(dir, 'buf.yaml'));
      cpSync(join(protoDir, 'finverity'), join(dir, 'finverity'), { recursive: true });
    }
    const file = join(changed, protoFile);
    const source = readFileSync(file, 'utf8');
    const without = source.replace(
      '  string invoice_id = 2;\n  // Invoice amount',
      '  // Invoice amount',
    );
    expect(without).not.toBe(source);
    writeFileSync(file, without);

    const result = run(buf, ['breaking', changed, '--against', base]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('was deleted');

    const same = run(buf, ['breaking', base, '--against', base]);
    expect(same.status).toBe(0);
  });

  it('GR-01 wires proto:lint, proto:breaking, proto:generate and proto:check into make verify', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['proto:lint', 'proto:breaking', 'proto:generate', 'proto:check']) {
      expect(pkg.scripts[name], name).toBeTruthy();
    }
    const makefile = readFileSync(join(root, 'Makefile'), 'utf8');
    const verify = makefile.slice(makefile.indexOf('\nverify:'), makefile.indexOf('\ntest:'));
    for (const name of ['proto:lint', 'proto:breaking', 'proto:check']) {
      expect(verify, name).toContain(`npm run --silent ${name}`);
    }
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('npm run proto:lint');
    expect(ci).toContain('npm run proto:check');
    expect(ci).toMatch(/PROTO_BASE/);
  });
});
