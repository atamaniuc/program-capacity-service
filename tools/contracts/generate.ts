import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderContracts } from './render.js';

const CONTRACTS = resolve(import.meta.dirname, '../../contracts');

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

const rendered = renderContracts();
// A schema file whose message no longer exists is stale too.
const stale = (await readdir(resolve(CONTRACTS, 'json-schema')).catch(() => []))
  .map((name) => `json-schema/${name}`)
  .filter((path) => !rendered.has(path));

if (values.check) {
  const drifted: string[] = [...stale];
  for (const [path, content] of rendered) {
    const committed = await readFile(resolve(CONTRACTS, path), 'utf8').catch(() => '');
    if (committed !== content) drifted.push(path);
  }
  if (drifted.length > 0) {
    console.error(
      `contracts: ${drifted.map((path) => `contracts/${path}`).join(', ')} differ from the zod schemas. Run \`npm run contracts\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`contracts: ${rendered.size} files in contracts/ are up to date`);
} else {
  for (const [path, content] of rendered) {
    await mkdir(dirname(resolve(CONTRACTS, path)), { recursive: true });
    await writeFile(resolve(CONTRACTS, path), content);
  }
  for (const path of stale) await rm(resolve(CONTRACTS, path));
  console.log(`contracts: wrote ${rendered.size} files to contracts/`);
}
