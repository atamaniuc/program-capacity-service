import { z } from 'zod';
import { MESSAGE_EXAMPLES } from './asyncapi-examples.js';
import {
  CAPACITY_EVENTS_TOPIC,
  capacityEventHeadersSchema,
  programCapacityChangedSchema,
  reconciliationDriftDetectedSchema,
  reservationCreatedSchema,
  reservationReleasedSchema,
} from '#src/capacity/application/shared/capacity-events.js';
import {
  dlqHeadersSchema,
  dlqTopic,
  fxRatePublishedSchema,
  programLimitSetSchema,
  programReconciledSchema,
  repaymentReceivedSchema,
  TOPIC_CAPACITY,
  TOPIC_FX_RATES,
  TREASURY_CONSUMER_GROUP,
} from '#src/capacity/application/shared/treasury-messages.js';

/**
 * The Kafka contract (PRD §9, ADR 015) as one AsyncAPI 3.1 document, built from the zod schemas
 * that validate treasury input and type the outbound payloads. `npm run contracts` commits it as
 * `contracts/asyncapi.yaml` with payloads in `contracts/json-schema/`; `/docs/asyncapi` serves
 * the same document with the payloads inlined.
 */

const MESSAGES = {
  ProgramLimitSet: {
    schema: programLimitSetSchema,
    summary: 'Treasury sets the credit limit of a program, and optionally suspends it.',
  },
  RepaymentReceived: {
    schema: repaymentReceivedSchema,
    summary: 'Treasury received a repayment; the reservation of the invoice is released by it.',
  },
  ProgramReconciled: {
    schema: programReconciledSchema,
    summary:
      'Treasury snapshot of a program: limit and every open reservation, with the watermark of platform events treasury has applied.',
  },
  FxRatePublished: {
    schema: fxRatePublishedSchema,
    summary: 'Treasury FX rate; usable for FX_MAX_AGE (24 hours by default), the newest asOf wins.',
  },
  ReservationCreated: {
    schema: reservationCreatedSchema,
    summary: 'A reservation was created through the API.',
  },
  ReservationReleased: {
    schema: reservationReleasedSchema,
    summary:
      'A reservation was released, fully or in part, through the API or by a treasury repayment.',
  },
  ProgramCapacityChanged: {
    schema: programCapacityChangedSchema,
    summary:
      'Treasury applied a ProgramLimitSet (every one, including a suspend, a resume or the same limit again), or a snapshot changed the limit or the reservations. Carries the program status and the full capacity view.',
  },
  ReconciliationDriftDetected: {
    schema: reconciliationDriftDetectedSchema,
    summary: 'A treasury snapshot disagreed with the platform beyond tolerance.',
  },
} as const;

export type ContractMessage = keyof typeof MESSAGES;
export const CONTRACT_MESSAGES = Object.keys(MESSAGES) as ContractMessage[];
export const TREASURY_MESSAGES: readonly ContractMessage[] = [
  'ProgramLimitSet',
  'RepaymentReceived',
  'ProgramReconciled',
  'FxRatePublished',
];
export const CAPACITY_EVENTS: readonly ContractMessage[] = [
  'ReservationCreated',
  'ReservationReleased',
  'ProgramCapacityChanged',
  'ReconciliationDriftDetected',
];

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Replaces every `#/definitions/<name>` reference with the definition itself (no cycles here). */
function inlineDefinitions(node: unknown, definitions: JsonObject): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineDefinitions(item, definitions));
  if (!isObject(node)) return node;
  const entries = Object.entries(node).map(([key, value]) => [
    key,
    inlineDefinitions(value, definitions),
  ]);
  const resolved = Object.fromEntries(entries) as JsonObject;
  const { $ref, ...rest } = resolved;
  if (typeof $ref !== 'string') return resolved;
  const target = definitions[$ref.replace('#/definitions/', '')];
  if (target === undefined) throw new Error(`unresolved schema reference ${$ref}`);
  return { ...(inlineDefinitions(target, definitions) as JsonObject), ...rest };
}

/**
 * Self-contained JSON Schema draft-07 (the dialect AsyncAPI schemas extend) of a zod schema.
 * `input` is the published, open contract: consumers ignore fields they do not know, so v1 can
 * grow. `output` adds `additionalProperties: false`, which tests use to prove the producer sends
 * no field the contract leaves out.
 */
export function jsonSchemaOf(
  schema: z.ZodType,
  title: string,
  io: 'input' | 'output' = 'input',
): JsonObject {
  const { definitions = {}, ...root } = z.toJSONSchema(schema, {
    target: 'draft-7',
    io,
    reused: 'inline',
  }) as JsonObject & { definitions?: JsonObject };
  const { $schema, ...body } = inlineDefinitions(root, definitions) as JsonObject;
  return { $schema, title, ...body };
}

export function messageJsonSchema(name: ContractMessage, io: 'input' | 'output' = 'input') {
  return jsonSchemaOf(MESSAGES[name].schema, name, io);
}

/** A component schema inside the document: the document already fixes the dialect. */
const headersSchema = (schema: z.ZodType, title: string): JsonObject =>
  Object.fromEntries(
    Object.entries(jsonSchemaOf(schema, title)).filter(([key]) => key !== '$schema'),
  );

export const CAPACITY_EVENT_HEADERS = headersSchema(
  capacityEventHeadersSchema,
  'CapacityEventHeaders',
);
export const DLQ_HEADERS = headersSchema(dlqHeadersSchema, 'DlqHeaders');

const KAFKA_BINDING = '0.5.0';

const DESCRIPTION = `Every Kafka topic the service reads or writes. Treasury message shapes are an assumption (PRD A2): the assignment does not define them.

**Envelope.** Every message is JSON with one envelope: \`messageId\`, \`type\`, \`schemaVersion\`, \`tenantId\`, \`programId\`, \`seq\`, \`occurredAt\`, \`payload\`. Money is a decimal string at the ISO 4217 scale, never a JSON number; its currency is the \`currency\` beside it or, in \`capacity\` objects, the program currency. One exception: drift amounts in \`ReconciliationDriftDetected\` are integer minor-unit strings (\`invoiceMinor\`, \`programMinor\`), as the ledger stores them.

**Order.** Capacity messages and events are keyed \`tenantId:programId\`, so one program stays on one partition and in order.

**Delivery.** At least once in both directions. The service deduplicates treasury messages by \`messageId\` (inbox); consumers of \`capacity.events.v1\` deduplicate by \`messageId\` and can detect a gap or a replay with \`seq\`, which is gap-free per program.

**Outbound events** are written to the outbox in the same transaction as the change and published by the worker's relay after commit, so an event exists exactly when its change committed. While Kafka is down they wait in the outbox (metric \`outbox_lag\`).

**Evolution.** Within \`v1\` the only changes are a new optional field and a new event type: consumers must ignore fields and event types they do not know. Enums (\`status\`, \`reason\`, \`cause\`, \`kind\`, \`mode\`) are closed; a new value, like any other breaking change, gets a new topic (\`capacity.events.v2\`) and a new \`schemaVersion\`. CI enforces this (\`npm run contracts:compat\`).

**Not a full reservation log.** Reconciliation can adjust, adopt or release reservations; it reports that as one \`ProgramCapacityChanged\` (cause \`reconciliation\`) plus a \`ReconciliationDriftDetected\` with at most 100 drifts, not as per-reservation events. A consumer that needs every reservation's state reads it from the REST API after such an event.

**Invalid input.** A treasury message that fails validation is published unchanged to \`<topic>.dlq\` with \`x-error-*\` and \`x-original-*\` headers and the consumer moves on; \`npm run dlq-replay\` sends it back.`;

const keyBinding = (description: string) => ({
  kafka: { key: { type: 'string', description }, bindingVersion: KAFKA_BINDING },
});

const PROGRAM_KEY = 'tenantId:programId, for example bank-a:prg_grand_usd.';

/**
 * `payloads: 'files'` references `../packages/contracts/json-schema/capacity.events.v1/<name>.schema.json` (the committed layout);
 * `'inline'` embeds the same schemas, for a browser that cannot follow relative files.
 */
export interface AsyncApiDocument extends JsonObject {
  readonly asyncapi: string;
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
}

export function buildAsyncApiDocument(options: {
  payloads: 'files' | 'inline';
  /** The broker as the host sees it; the default is the compose default of HOST_PORT_KAFKA (ADR 027). */
  localKafkaHost?: string;
}): AsyncApiDocument {
  const capacityKey = keyBinding(PROGRAM_KEY);
  const fxKey = keyBinding('Currency pair, base then quote, for example EURUSD.');
  const message = (name: ContractMessage) => ({
    name,
    title: name,
    summary: MESSAGES[name].summary,
    contentType: 'application/json',
    ...(CAPACITY_EVENTS.includes(name)
      ? { headers: { $ref: '#/components/schemas/CapacityEventHeaders' } }
      : {}),
    payload:
      options.payloads === 'files'
        ? { $ref: `../packages/contracts/json-schema/capacity.events.v1/${name}.schema.json` }
        : messageJsonSchema(name),
    bindings: name === 'FxRatePublished' ? fxKey : capacityKey,
    examples: MESSAGE_EXAMPLES[name],
  });
  const ref = (name: string) => ({ $ref: `#/components/messages/${name}` });
  const channel = (name: string) => ({ $ref: `#/channels/${name}` });
  const groupBinding = {
    kafka: {
      groupId: { type: 'string', enum: [TREASURY_CONSUMER_GROUP] },
      bindingVersion: KAFKA_BINDING,
    },
  };

  return {
    asyncapi: '3.1.0',
    info: {
      title: 'Program Capacity Service - Kafka',
      version: '1.1.0',
      description: DESCRIPTION,
    },
    defaultContentType: 'application/json',
    servers: {
      local: {
        host: options.localKafkaHost ?? 'localhost:39092',
        protocol: 'kafka',
        description: 'The compose broker seen from the host (`make up`). PLAINTEXT, local only.',
      },
      compose: {
        host: 'kafka:9092',
        protocol: 'kafka',
        description: 'The same broker inside the compose network, as the service sees it.',
      },
    },
    channels: {
      treasuryCapacity: {
        address: TOPIC_CAPACITY,
        title: 'Treasury capacity messages',
        description:
          'Limits, repayments and reconciliation snapshots. Keyed tenantId:programId; the consumer keeps one message in flight per partition, so program order holds. `seq` is treasury’s per-program sequence: a message at or below the program’s last applied seq is skipped.',
        messages: {
          ProgramLimitSet: ref('ProgramLimitSet'),
          RepaymentReceived: ref('RepaymentReceived'),
          ProgramReconciled: ref('ProgramReconciled'),
        },
      },
      treasuryFxRates: {
        address: TOPIC_FX_RATES,
        title: 'Treasury FX rates',
        description:
          'Keyed by currency pair. Rates are global: tenantId and programId carry "*"; seq is not used for ordering, the newest asOf wins.',
        messages: { FxRatePublished: ref('FxRatePublished') },
      },
      capacityEvents: {
        address: CAPACITY_EVENTS_TOPIC,
        title: 'Capacity events',
        description:
          'Every committed change of a program, in commit order per program: reservations created and released (through the API or a treasury repayment), limit and status changes, reconciliation results. Reconciliation changes are reported per program, not per reservation. Keyed tenantId:programId; `seq` (and the `program-seq` header) is the gap-free per-program platform sequence, the same number treasury echoes back as `platformWatermark`.',
        messages: {
          ReservationCreated: ref('ReservationCreated'),
          ReservationReleased: ref('ReservationReleased'),
          ProgramCapacityChanged: ref('ProgramCapacityChanged'),
          ReconciliationDriftDetected: ref('ReconciliationDriftDetected'),
        },
      },
      treasuryCapacityDlq: {
        address: dlqTopic(TOPIC_CAPACITY),
        title: 'Parked treasury capacity messages',
        description: `Messages from ${TOPIC_CAPACITY} that failed validation or can never apply (for example an unknown program); retrying would not help.`,
        messages: { DeadLetter: ref('DeadLetter') },
      },
      treasuryFxRatesDlq: {
        address: dlqTopic(TOPIC_FX_RATES),
        title: 'Parked FX rate messages',
        description: `Messages from ${TOPIC_FX_RATES} that failed validation or can never apply.`,
        messages: { DeadLetter: ref('DeadLetter') },
      },
    },
    operations: {
      receiveCapacity: {
        action: 'receive',
        channel: channel('treasuryCapacity'),
        summary: 'Limits, repayments and reconciliation snapshots from treasury',
        bindings: groupBinding,
      },
      receiveFxRates: {
        action: 'receive',
        channel: channel('treasuryFxRates'),
        summary: 'FX rates from treasury',
        bindings: groupBinding,
      },
      publishCapacityEvents: {
        action: 'send',
        channel: channel('capacityEvents'),
        summary: 'Outbox relay: every committed change, acks=all, idempotent producer',
      },
      parkCapacityMessage: {
        action: 'send',
        channel: channel('treasuryCapacityDlq'),
        summary: 'A treasury capacity message that cannot be applied',
      },
      parkFxRate: {
        action: 'send',
        channel: channel('treasuryFxRatesDlq'),
        summary: 'An FX rate message that cannot be applied',
      },
    },
    components: {
      messages: {
        ...Object.fromEntries(CONTRACT_MESSAGES.map((name) => [name, message(name)])),
        DeadLetter: {
          name: 'DeadLetter',
          title: 'DeadLetter',
          summary: 'The original record, unchanged, with the reason it was parked.',
          contentType: 'application/octet-stream',
          headers: { $ref: '#/components/schemas/DlqHeaders' },
          payload: {
            description:
              'The original value bytes, unchanged; usually JSON, but a message that failed to parse is kept as it arrived.',
          },
          bindings: keyBinding('The original key, unchanged.'),
        },
      },
      schemas: { CapacityEventHeaders: CAPACITY_EVENT_HEADERS, DlqHeaders: DLQ_HEADERS },
    },
  };
}
