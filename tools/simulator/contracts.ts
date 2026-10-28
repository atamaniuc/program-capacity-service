import { z } from 'zod';
import { stringify } from 'yaml';
import {
  fxRatePublishedSchema,
  programLimitSetSchema,
  programReconciledSchema,
  repaymentReceivedSchema,
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
} from '../../src/capacity/application/shared/treasury-messages.js';

/** Treasury message contracts as JSON Schema files and an AsyncAPI document (PRD §9, A2). */

const SCHEMAS = {
  ProgramLimitSet: programLimitSetSchema,
  RepaymentReceived: repaymentReceivedSchema,
  ProgramReconciled: programReconciledSchema,
  FxRatePublished: fxRatePublishedSchema,
} as const;

export type ContractName = keyof typeof SCHEMAS;
export const CONTRACT_NAMES = Object.keys(SCHEMAS) as ContractName[];

function jsonSchemaOf(name: ContractName): Record<string, unknown> {
  const schema = z.toJSONSchema(SCHEMAS[name], {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'inline',
  });
  return { ...schema, title: name };
}

/** File name (relative to contracts/json-schema/) → file content. */
export function renderJsonSchemas(): Map<string, string> {
  return new Map(
    CONTRACT_NAMES.map((name) => [
      `${name}.schema.json`,
      `${JSON.stringify(jsonSchemaOf(name), null, 2)}\n`,
    ]),
  );
}

export function renderAsyncApi(): string {
  const message = (name: ContractName) => ({
    name,
    contentType: 'application/json',
    payload: { $ref: `./json-schema/${name}.schema.json` },
  });
  const document = {
    asyncapi: '3.0.0',
    info: {
      title: 'Program Capacity Service - treasury input',
      version: '1.0.0',
      description:
        'Treasury message shapes are an assumption (PRD A2): the assignment does not define them. ' +
        'JSON, one envelope (messageId, type, schemaVersion, tenantId, programId, seq, occurredAt, payload). ' +
        'Money is a decimal string with its ISO 4217 currency. A message that fails validation is ' +
        'published unchanged to <topic>.dlq with x-error-code, x-error-message and x-original-* headers.',
    },
    servers: { local: { host: 'localhost:29092', protocol: 'kafka' } },
    channels: {
      treasuryCapacity: {
        address: TOPIC_CAPACITY,
        description:
          'Keyed by tenantId:programId; one message in flight per partition keeps program order.',
        messages: {
          ProgramLimitSet: { $ref: '#/components/messages/ProgramLimitSet' },
          RepaymentReceived: { $ref: '#/components/messages/RepaymentReceived' },
          ProgramReconciled: { $ref: '#/components/messages/ProgramReconciled' },
        },
      },
      treasuryFxRates: {
        address: TOPIC_FX_RATES,
        description:
          'Keyed by currency pair. Rates are global: tenantId and programId carry "*"; seq is not used for ordering, the newest asOf wins.',
        messages: { FxRatePublished: { $ref: '#/components/messages/FxRatePublished' } },
      },
    },
    operations: {
      receiveCapacity: {
        action: 'receive',
        channel: { $ref: '#/channels/treasuryCapacity' },
        summary: 'Limits, repayments and reconciliation snapshots from treasury',
      },
      receiveFxRates: {
        action: 'receive',
        channel: { $ref: '#/channels/treasuryFxRates' },
        summary: 'FX rates from treasury',
      },
    },
    components: {
      messages: Object.fromEntries(CONTRACT_NAMES.map((name) => [name, message(name)])),
    },
  };
  return stringify(document);
}
