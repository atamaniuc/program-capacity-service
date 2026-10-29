import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import { default as addFormatsModule } from 'ajv-formats';
import {
  CAPACITY_EVENT_HEADERS,
  CONTRACT_MESSAGES,
  DLQ_HEADERS,
  messageJsonSchema,
  type ContractMessage,
} from '#src/platform/contracts/asyncapi.js';

const ROOT = resolve(import.meta.dirname, '../..');

export interface ContractValidators {
  /** The committed, open schemas in `contracts/json-schema/`: what consumers validate against. */
  readonly committed: ReadonlyMap<ContractMessage, ValidateFunction>;
  /** The same schemas with `additionalProperties: false`: no field the contract leaves out. */
  readonly strict: ReadonlyMap<ContractMessage, ValidateFunction>;
  readonly eventHeaders: ValidateFunction;
  readonly dlqHeaders: ValidateFunction;
  errors(validate: ValidateFunction): string;
}

/** JSON Schema draft-07 validators (the dialect of `contracts/json-schema/`) with formats. */
export async function contractValidators(): Promise<ContractValidators> {
  const ajv = new Ajv({ strict: false, allErrors: true });
  (addFormatsModule as unknown as (instance: Ajv) => void)(ajv);
  const committed = new Map<ContractMessage, ValidateFunction>();
  const strict = new Map<ContractMessage, ValidateFunction>();
  for (const name of CONTRACT_MESSAGES) {
    const file = await readFile(resolve(ROOT, `contracts/json-schema/${name}.schema.json`), 'utf8');
    committed.set(name, ajv.compile(JSON.parse(file) as object));
    strict.set(name, ajv.compile(messageJsonSchema(name, 'output')));
  }
  return {
    committed,
    strict,
    eventHeaders: ajv.compile(CAPACITY_EVENT_HEADERS),
    dlqHeaders: ajv.compile(DLQ_HEADERS),
    errors: (validate) => ajv.errorsText(validate.errors),
  };
}
