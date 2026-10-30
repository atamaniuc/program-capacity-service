import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderContracts } from './render.js';

const CONTRACTS = resolve(import.meta.dirname, '../../contracts');
const SCHEMAS = resolve(import.meta.dirname, '../../packages/contracts/json-schema/capacity.events.v1');
// Schema files are rendered as `json-schema/<File>`; they live in @finverity/contracts (ADR 028).
const target = (path: string): string =>
  path.startsWith('json-schema/') ? resolve(SCHEMAS, path.slice('json-schema/'.length)) : resolve(CONTRACTS, path);

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

const rendered = renderContracts();
// A schema file whose message no longer exists is stale too.
const stale = (await readdir(SCHEMAS).catch(() => []))
  .map((name) => `json-schema/${name}`)
  .filter((path) => !rendered.has(path));

if (values.check) {
  const drifted: string[] = [...stale];
  for (const [path, content] of rendered) {
    const committed = await readFile(target(path), 'utf8').catch(() => '');
    if (committed !== content) drifted.push(path);
  }
  if (drifted.length > 0) {
    console.error(
      `contracts: ${drifted.join(', ')} differ from the zod schemas. Run \`npm run contracts\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`contracts: ${rendered.size} files in contracts/ are up to date`);
} else {
  for (const [path, content] of rendered) {
    await mkdir(dirname(target(path)), { recursive: true });
    await writeFile(target(path), content);
  }
  for (const path of stale) await rm(target(path));
  console.log(`contracts: wrote ${rendered.size} files to contracts/`);
}
