import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../src/funding/adapters/in/http/openapi.js';

const FILE = fileURLToPath(new URL('../contracts/openapi.yaml', import.meta.url));

/** The committed `contracts/openapi.yaml`, rendered from the zod schemas. */
export function renderOpenApiYaml(): string {
  return stringify(
    buildOpenApiDocument({
      localApiHost: `localhost:${process.env['HOST_PORT_FUNDING'] ?? '13100'}`,
    }),
    { lineWidth: 100, aliasDuplicateObjects: false },
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const rendered = renderOpenApiYaml();
  if (process.argv.includes('--check')) {
    const committed = await readFile(FILE, 'utf8').catch(() => '');
    if (committed !== rendered) {
      console.error('contracts/openapi.yaml drifted; run npm run contracts -w @finverity/funding');
      process.exit(1);
    }
    console.log('funding contracts: up to date');
  } else {
    await writeFile(FILE, rendered);
    console.log('funding contracts: written');
  }
}
