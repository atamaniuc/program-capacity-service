import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { compareSchemas } from '@finverity/contracts/compare-schemas';

/**
 * NFR-14: no breaking change to a published contract within v1. Compares `contracts/` with the
 * same files at `--base` (default HEAD):
 * - the header schemas in `asyncapi.yaml` (the event schemas live in @finverity/contracts, ADR 028), with
 *   `compareSchemas` (the only allowed change is a new optional field or a new event type);
 * - `openapi.yaml` with oasdiff (`breaking --fail-on ERR`) in Docker.
 * A breaking change needs a new version (`/v2`, `capacity.events.v2`), not an edit.
 */

const OASDIFF_IMAGE = 'tufin/oasdiff:v1.34.0';
const ROOT = resolve(import.meta.dirname, '../..');

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'HEAD' },
    // CI sets it: without Docker the REST half of the check would silently not run.
    'require-oasdiff': { type: 'boolean', default: false },
  },
});

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function resolveBase(ref: string | undefined): string {
  for (const candidate of [ref, 'HEAD']) {
    if (candidate === undefined || candidate === '' || /^0+$/.test(candidate)) continue;
    try {
      return git('rev-parse', '--verify', `${candidate}^{commit}`).trim();
    } catch {
      console.warn(`contracts:compat: cannot resolve ${candidate}`);
    }
  }
  throw new Error('contracts:compat: no base commit to compare with');
}

const base = resolveBase(values.base);
const atBase = (path: string): string | null => {
  try {
    return git('show', `${base}:contracts/${path}`);
  } catch {
    return null;
  }
};
const current = (path: string): string | null => {
  try {
    return readFileSync(resolve(ROOT, 'contracts', path), 'utf8');
  } catch {
    return null;
  }
};

const problems: string[] = [];
type AsyncApi = { components?: { schemas?: Record<string, object> } } | null;
const baseAsync = parse(atBase('asyncapi.yaml') ?? 'null') as AsyncApi;
const nowAsync = parse(current('asyncapi.yaml') ?? 'null') as AsyncApi;
for (const [name, schema] of Object.entries(baseAsync?.components?.schemas ?? {})) {
  const now = nowAsync?.components?.schemas?.[name];
  if (now === undefined) problems.push(`asyncapi.yaml components.schemas.${name}: removed`);
  else for (const problem of compareSchemas(schema, now)) problems.push(`asyncapi.yaml ${name}: ${problem}`);
}

let oasdiff = 'skipped';
const baseOpenApi = atBase('openapi.yaml');
if (baseOpenApi !== null) {
  let docker = true;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
  } catch {
    docker = false;
  }
  if (!docker && values['require-oasdiff']) {
    problems.push('openapi.yaml: Docker is not available, so oasdiff could not run');
  } else if (docker) {
    const dir = mkdtempSync(join(tmpdir(), 'oasdiff-'));
    try {
      writeFileSync(join(dir, 'base.yaml'), baseOpenApi);
      writeFileSync(join(dir, 'revision.yaml'), current('openapi.yaml') ?? '');
      const args = ['run', '--rm', '-v', `${dir}:/specs:ro`, OASDIFF_IMAGE, 'breaking'];
      execFileSync('docker', [...args, '/specs/base.yaml', '/specs/revision.yaml', '--fail-on', 'ERR'], {
        stdio: 'inherit',
      });
      oasdiff = 'no breaking change';
    } catch {
      problems.push('openapi.yaml: oasdiff reports a breaking change (see above)');
      oasdiff = 'breaking';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(
  `contracts:compat: base ${base.slice(0, 7)}; header schemas compared (event schemas: npm run schema:compat in @finverity/contracts); OpenAPI: ${oasdiff}; breaking=${problems.length}`,
);
for (const problem of problems) console.error(`  ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
