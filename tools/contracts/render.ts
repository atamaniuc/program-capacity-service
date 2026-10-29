import { stringify } from 'yaml';
import { buildOpenApiDocument } from '#src/capacity/adapters/in/http/openapi.js';
import {
  buildAsyncApiDocument,
  CONTRACT_MESSAGES,
  messageJsonSchema,
} from '#src/platform/contracts/asyncapi.js';

/** The committed `contracts/openapi.yaml`, rendered from the zod schemas. */
export function renderOpenApiYaml(): string {
  return stringify(buildOpenApiDocument(), { lineWidth: 100, aliasDuplicateObjects: false });
}

/** The committed `contracts/asyncapi.yaml`; payloads live in `json-schema/`. */
export function renderAsyncApiYaml(): string {
  return stringify(buildAsyncApiDocument({ payloads: 'files' }), {
    lineWidth: 100,
    aliasDuplicateObjects: false,
  });
}

/** File name (relative to contracts/json-schema/) → content, one per Kafka message. */
export function renderJsonSchemas(): Map<string, string> {
  return new Map(
    CONTRACT_MESSAGES.map((name) => [
      `${name}.schema.json`,
      `${JSON.stringify(messageJsonSchema(name), null, 2)}\n`,
    ]),
  );
}

/** Every generated file under `contracts/`, path relative to it → content. */
export function renderContracts(): Map<string, string> {
  return new Map([
    ['openapi.yaml', renderOpenApiYaml()],
    ['asyncapi.yaml', renderAsyncApiYaml()],
    ...[...renderJsonSchemas()].map(([name, content]) => [`json-schema/${name}`, content] as const),
  ]);
}
