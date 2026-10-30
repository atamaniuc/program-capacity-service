/**
 * Generates the committed gRPC stubs (ADR 024, 028) with buf and ts-proto into @finverity/contracts.
 *   tsx packages/contracts/tools/generate.ts          write the stubs
 *   tsx packages/contracts/tools/generate.ts --check  fail when the committed stubs differ from a fresh run
 * Run from the repository root; the buf.gen templates use root-relative output paths.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../..', import.meta.url).pathname;
const proto = 'packages/contracts/proto';
const templates = [`${proto}/buf.gen.yaml`];
const outputs = ['packages/contracts/src/generated'];
const check = process.argv.includes('--check');

function buf(args: string[]): void {
  const run = spawnSync(join(root, 'node_modules/.bin/buf'), args, { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

if (!check) {
  for (const template of templates) buf(['generate', proto, '--template', template]);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'proto-check-'));
try {
  for (const template of templates) {
    buf(['generate', proto, '--template', template, '--output', scratch]);
  }
  const drift: string[] = [];
  for (const out of outputs) {
    const fresh = files(join(scratch, out)).map((f) => f.slice(join(scratch, out).length));
    const committed = files(join(root, out)).map((f) => f.slice(join(root, out).length));
    for (const rel of new Set([...fresh, ...committed])) {
      const a = join(scratch, out, rel);
      const b = join(root, out, rel);
      if (!existsSync(a) || !existsSync(b) || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8')) {
        drift.push(join(out, rel));
      }
    }
  }
  if (drift.length > 0) {
    console.error(`proto stubs drifted; run npm run proto:generate:\n${drift.join('\n')}`);
    process.exit(1);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
