import { Parser } from '@asyncapi/parser';
import { describe, expect, it } from 'vitest';
import { contractValidators } from '../../tools/contracts/validators.js';
import { MESSAGE_EXAMPLES } from '#src/platform/contracts/asyncapi-examples.js';
import {
  buildAsyncApiDocument,
  CAPACITY_EVENTS,
  CONTRACT_MESSAGES,
  messageJsonSchema,
  TREASURY_MESSAGES,
} from '#src/platform/contracts/asyncapi.js';

interface Doc {
  channels: Record<string, { address: string; messages: Record<string, { $ref: string }> }>;
  operations: Record<string, { action: string; channel: { $ref: string } }>;
  components: { messages: Record<string, { payload: unknown; headers?: unknown }> };
}

const inline = () => buildAsyncApiDocument({ payloads: 'inline' }) as unknown as Doc;

describe('AsyncAPI contract', () => {
  it('NFR-14 the served document is valid AsyncAPI 3.1 with no error or warning', async () => {
    const { document, diagnostics } = await new Parser().parse(JSON.stringify(inline()));
    // Severity 0 is an error and 1 a warning (Spectral); information and hints are fine.
    const blocking = diagnostics.filter((d) => Number(d.severity) <= 1);
    expect(blocking.map((d) => d.message)).toEqual([]);
    expect(document?.version()).toBe('3.1.0');
  });

  it('FR-13 documents every topic: treasury input, both DLQs and capacity.events.v1 in and out', () => {
    const doc = inline();
    const byAddress = Object.fromEntries(
      Object.values(doc.channels).map((channel) => [
        channel.address,
        Object.keys(channel.messages).sort(),
      ]),
    );
    expect(byAddress).toEqual({
      'treasury.capacity.v1': ['ProgramLimitSet', 'ProgramReconciled', 'RepaymentReceived'],
      'treasury.fx-rates.v1': ['FxRatePublished'],
      'capacity.events.v1': [
        'ProgramCapacityChanged',
        'ReconciliationDriftDetected',
        'ReservationCreated',
        'ReservationReleased',
      ],
      'treasury.capacity.v1.dlq': ['DeadLetter'],
      'treasury.fx-rates.v1.dlq': ['DeadLetter'],
    });
    const actions = Object.values(doc.operations).map((operation) => [
      doc.channels[operation.channel.$ref.replace('#/channels/', '')]?.address,
      operation.action,
    ]);
    expect(actions).toEqual([
      ['treasury.capacity.v1', 'receive'],
      ['treasury.fx-rates.v1', 'receive'],
      ['capacity.events.v1', 'send'],
      ['treasury.capacity.v1.dlq', 'send'],
      ['treasury.fx-rates.v1.dlq', 'send'],
    ]);
    expect([...TREASURY_MESSAGES, ...CAPACITY_EVENTS].sort()).toEqual(
      [...CONTRACT_MESSAGES].sort(),
    );
    for (const name of CAPACITY_EVENTS) {
      expect(doc.components.messages[name]?.headers).toEqual({
        $ref: '#/components/schemas/CapacityEventHeaders',
      });
    }
  });

  it('NFR-14 the committed document references the same payload schemas the served one inlines', () => {
    const files = buildAsyncApiDocument({ payloads: 'files' }) as unknown as Doc;
    const served = inline();
    for (const name of CONTRACT_MESSAGES) {
      expect(files.components.messages[name]?.payload).toEqual({
        $ref: `../packages/contracts/json-schema/capacity.events.v1/${name}.schema.json`,
      });
      expect(served.components.messages[name]?.payload).toEqual(messageJsonSchema(name));
    }
  });

  it('FR-13 every documented example is a message the contract accepts, field for field', async () => {
    const validators = await contractValidators();
    for (const name of CONTRACT_MESSAGES) {
      const examples = MESSAGE_EXAMPLES[name];
      expect(examples.length, name).toBeGreaterThan(0);
      for (const example of examples) {
        const validate = validators.strict.get(name);
        expect(
          validate?.(example.payload),
          `${name}/${example.name}: ${validators.errors(validate!)}`,
        ).toBe(true);
        if (CAPACITY_EVENTS.includes(name)) {
          const envelope = example.payload as {
            messageId: string;
            seq: number;
            payload: { programSeq: number };
          };
          expect(
            validators.eventHeaders(example.headers),
            validators.errors(validators.eventHeaders),
          ).toBe(true);
          expect(example.headers?.['event-id']).toBe(envelope.messageId);
          expect(example.headers?.['program-seq']).toBe(String(envelope.seq));
          expect(envelope.payload.programSeq).toBe(envelope.seq);
        }
      }
    }
  });

  it('FR-13 the strict schemas reject a field the contract leaves out; the published ones accept it', async () => {
    const validators = await contractValidators();
    const [example] = MESSAGE_EXAMPLES.ReservationCreated;
    const extra = { ...(example?.payload as object), surprise: true };
    expect(validators.strict.get('ReservationCreated')?.(extra)).toBe(false);
    expect(validators.committed.get('ReservationCreated')?.(extra)).toBe(true);
    const wrongCause = structuredClone(MESSAGE_EXAMPLES.ProgramCapacityChanged[0]?.payload) as {
      payload: { cause: string };
    };
    wrongCause.payload.cause = 'manual';
    expect(validators.committed.get('ProgramCapacityChanged')?.(wrongCause)).toBe(false);
  });
});
