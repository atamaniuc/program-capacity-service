import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { incompatibleChanges, type SchemaSet } from './event-schemas.js';

/**
 * Compares the event schemas in `packages/contracts/json-schema/` with the base commit
 * (SCHEMA_BASE; default HEAD, so a local edit is caught; CI passes the merge base). A baseline from
 * before the package existed read `contracts/json-schema/<File>` and counts as `capacity.events.v1`.
 */
const root = resolve(import.meta.dirname, '../../..');
const dir = 'packages/contracts/json-schema';
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function files(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? files(child) : [child];
  });
}

const requested = process.env['SCHEMA_BASE'] ?? '';
if (/^0+$/.test(requested)) {
  console.log('schema:compat: no baseline commit (new branch); nothing to compare');
  process.exit(0);
}
const base = git('rev-parse', '--verify', `${requested === '' ? 'HEAD' : requested}^{commit}`).trim();

const baseSet = new Map<string, object>();
const lines = (prefix: string): string[] => {
  try {
    return git('ls-tree', '-r', '--name-only', base, prefix).split('\n').filter((l) => l.endsWith('.schema.json'));
  } catch {
    return [];
  }
};
for (const path of lines(dir)) {
  baseSet.set(path.slice(dir.length + 1), JSON.parse(git('show', `${base}:${path}`)) as object);
}
for (const path of lines('contracts/json-schema')) {
  baseSet.set(`capacity.events.v1/${path.split('/').pop()}`, JSON.parse(git('show', `${base}:${path}`)) as object);
}

const current: SchemaSet = new Map(
  (existsSync(join(root, dir)) ? files(join(root, dir)) : [])
    .filter((f) => f.endsWith('.schema.json'))
    .map((f) => [relative(join(root, dir), f), JSON.parse(readFileSync(f, 'utf8')) as object]),
);

const problems = incompatibleChanges(baseSet, current);
console.log(
  `schema:compat: base ${base.slice(0, 7)}; ${baseSet.size} base and ${current.size} current event schema(s); breaking=${problems.length}`,
);
for (const problem of problems) console.error(`  ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
