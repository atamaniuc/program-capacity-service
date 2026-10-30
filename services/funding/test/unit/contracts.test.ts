import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderOpenApiYaml } from '../../tools/contracts.js';

describe('funding contracts', () => {
  it('FS-02 contracts/openapi.yaml is the zod-generated document (no drift)', async () => {
    const committed = await readFile(
      fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)),
      'utf8',
    );
    expect(committed).toBe(renderOpenApiYaml());
  });
});
