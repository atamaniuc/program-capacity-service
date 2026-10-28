import { stringify } from 'yaml';
import { buildOpenApiDocument } from '#src/capacity/adapters/in/http/openapi.js';

/** The committed `contracts/openapi.yaml`, rendered from the zod schemas. */
export function renderOpenApiYaml(): string {
  return stringify(buildOpenApiDocument(), { lineWidth: 100, aliasDuplicateObjects: false });
}
