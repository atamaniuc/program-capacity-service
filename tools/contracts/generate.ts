import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderOpenApiYaml } from './render.js';

const COMMITTED = resolve(import.meta.dirname, '../../contracts/openapi.yaml');

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

if (values.check) {
  const committed = await readFile(COMMITTED, 'utf8').catch(() => '');
  if (committed !== renderOpenApiYaml()) {
    console.error(
      'contracts: contracts/openapi.yaml differs from the zod schemas. Run `npm run contracts` and commit the result.',
    );
    process.exit(1);
  }
  console.log('contracts: contracts/openapi.yaml is up to date');
} else {
  await mkdir(dirname(COMMITTED), { recursive: true });
  await writeFile(COMMITTED, renderOpenApiYaml());
  console.log(`contracts: wrote ${COMMITTED}`);
}
