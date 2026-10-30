import { describe, expect, it } from 'vitest';
import { messageJsonSchema } from '#src/platform/contracts/asyncapi.js';
import { compareSchemas } from '@finverity/contracts/compare-schemas';

interface Node {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  required?: string[];
  enum?: string[];
}

const base = () => messageJsonSchema('ReservationReleased') as unknown as Node;
const payloadOf = (schema: Node) => schema.properties['payload'] as Node;

describe('contract compatibility check', () => {
  it('NFR-14 accepts an unchanged schema, documentation edits and a new optional field', () => {
    expect(compareSchemas(base(), base())).toEqual([]);
    const after = base();
    payloadOf(after).properties['releaseRef'] = {
      ...(payloadOf(after).properties['releaseRef'] as object),
      description: 'reworded',
    };
    payloadOf(after).properties['note'] = { type: 'string' };
    expect(compareSchemas(base(), after)).toEqual([]);
  });

  it('NFR-14 reports a removed, newly required or retyped field and a new enum value', () => {
    const removed = base();
    delete payloadOf(removed).properties['remainingAmount'];
    expect(compareSchemas(base(), removed)).toContain('$.payload.remainingAmount: removed');

    const required = base();
    payloadOf(required).properties['note'] = { type: 'string' };
    payloadOf(required).required = [...(payloadOf(required).required ?? []), 'note'];
    expect(compareSchemas(base(), required)).toContain('$.payload.note: newly required');

    const retyped = base();
    payloadOf(retyped).properties['programSeq'] = { type: 'string' };
    expect(compareSchemas(base(), retyped).join()).toContain('$.payload.programSeq: type');

    const widened = base();
    const reason = payloadOf(widened).properties['reason'] as Node;
    reason.enum = [...(reason.enum ?? []), 'WRITTEN_OFF'];
    expect(compareSchemas(base(), widened).join()).toContain('$.payload.reason: enum');
  });

  it('NFR-14 lets the event-type header gain a value but not lose one', () => {
    const header = (values: string[]) => ({
      type: 'object',
      properties: { 'event-type': { type: 'string', enum: values } },
    });
    expect(compareSchemas(header(['A']), header(['A', 'B']))).toEqual([]);
    expect(compareSchemas(header(['A', 'B']), header(['A']))).toEqual([
      '$.event-type: enum lost B',
    ]);
  });

  it('NFR-14 sees through $ref and $defs, so a file layout change is not a contract change', () => {
    const flat = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const nested = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/M',
      $defs: { M: flat },
    };
    expect(compareSchemas(nested, flat)).toEqual([]);
  });
});
