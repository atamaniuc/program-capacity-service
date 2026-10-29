import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
type Json = Record<string, unknown>;
const json = (path: string): Json => JSON.parse(read(path)) as Json;

const services = ['funding', 'payments-mock'];
const requiredScripts = ['lint', 'typecheck', 'depcruise', 'test:unit', 'test:int'];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js|cjs|mjs)$/.test(name) ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) found.push(m[1]!);
  return found;
}

/** A specifier crosses a service boundary when it names another workspace's directory. */
function crossing(specifier: string, own: string): boolean {
  const target = /(?:^|\/)services\/([^/]+)\//.exec(specifier)?.[1];
  return target !== undefined && target !== own;
}

describe('npm workspaces', () => {
  it('WS-01 declares services/* and packages/* as the root workspaces', () => {
    expect(json('package.json').workspaces).toEqual(['services/*', 'packages/*']);
    expect(existsSync(join(root, 'package-lock.json'))).toBe(true);
  });

  it.each(services)('WS-01 %s is a complete workspace', (name) => {
    const dir = `services/${name}`;
    const pkg = json(`${dir}/package.json`) as Json & { scripts: Json };
    expect(pkg.name).toBe(`@finverity/${name}`);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.imports).toEqual({ '#src/*': './src/*' });
    for (const script of requiredScripts) expect(pkg.scripts).toHaveProperty([script]);
    expect(json(`${dir}/tsconfig.json`).extends).toBe('../../tsconfig.json');
    const vitest = read(`${dir}/vitest.config.ts`);
    expect(vitest).toContain("name: 'unit'");
    expect(vitest).toContain("name: 'int'");
    expect(read(`${dir}/.dependency-cruiser.cjs`)).toContain('no-cross-service-imports');
    expect(sourceFiles(join(root, dir, 'test')).some((f) => f.endsWith('.test.ts'))).toBe(true);
  });

  it('WS-01 the harness scans services/ and packages/', () => {
    const cfg = json('harnessimo.config.json').cleanExit as {
      scan: string[];
      codePrefixes: string[];
    };
    for (const prefix of ['services/', 'packages/']) {
      expect(cfg.scan).toContain(prefix);
      expect(cfg.codePrefixes).toContain(prefix);
    }
  });

  it('WS-01 make verify and make test run every workspace', () => {
    const make = read('Makefile');
    for (const script of ['lint', 'typecheck', 'depcruise', 'test:unit', 'test:int']) {
      expect(make).toContain(`npm run --silent ${script} --workspaces --if-present`);
    }
  });

  it('WS-01 no service imports another service, and root src imports no service', () => {
    const offences: string[] = [];
    for (const own of services) {
      for (const file of sourceFiles(join(root, 'services', own))) {
        for (const s of specifiers(readFileSync(file, 'utf8'))) {
          if (crossing(s, own)) offences.push(`${file}: ${s}`);
        }
      }
    }
    for (const dir of ['src', 'test', 'tools', 'db']) {
      for (const file of sourceFiles(join(root, dir))) {
        if (file.includes('/test/architecture/')) continue;
        for (const s of specifiers(readFileSync(file, 'utf8'))) {
          if (/(?:^|\/)(services|packages)\//.test(s)) offences.push(`${file}: ${s}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('WS-01 the crossing detector flags a sibling service and passes own code', () => {
    expect(crossing('../../../services/payments-mock/src/x.ts', 'funding')).toBe(true);
    expect(crossing('../../../services/funding/src/x.ts', 'funding')).toBe(false);
    expect(crossing('#src/service-name.ts', 'funding')).toBe(false);
  });
});
