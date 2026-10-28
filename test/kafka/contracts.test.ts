import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as addFormatsModule } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { renderAsyncApi, renderJsonSchemas } from '../../tools/simulator/contracts.js';
import { fxRate, limitSet, repayment, snapshot } from '../../tools/simulator/messages.js';
import { buildScenario, defaultContext, SCENARIO_NAMES } from '../../tools/simulator/scenarios.js';

const ROOT = resolve(import.meta.dirname, '../..');

async function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormatsModule as unknown as (instance: Ajv2020) => void)(ajv);
  const schemas = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const name of renderJsonSchemas().keys()) {
    const file = await readFile(resolve(ROOT, 'contracts/json-schema', name), 'utf8');
    schemas.set(name.replace('.schema.json', ''), ajv.compile(JSON.parse(file) as object));
  }
  return schemas;
}

describe('treasury message contracts', () => {
  it('T1 schemas: the committed JSON Schema files and asyncapi.yaml match the zod source', async () => {
    for (const [name, content] of renderJsonSchemas()) {
      const committed = await readFile(resolve(ROOT, 'contracts/json-schema', name), 'utf8');
      expect(committed, `${name} is stale; run npm run simulate -- export-contracts`).toBe(content);
    }
    const asyncapi = await readFile(resolve(ROOT, 'contracts/asyncapi.yaml'), 'utf8');
    expect(asyncapi).toBe(renderAsyncApi());
  });

  it('T1 schemas: every message the simulator produces validates against the exported JSON Schema', async () => {
    const schemas = await validator();
    const context = defaultContext({
      known: [
        {
          invoiceId: 'INV-1',
          outstandingInvoiceAmount: { value: '10.00', currency: 'USD' },
          outstandingReservedAmount: { value: '10.00', currency: 'USD' },
        },
      ],
      platformWatermark: 7,
    });
    const produced = SCENARIO_NAMES.flatMap((name) => buildScenario(name, context)).filter(
      (message) => !message.value.startsWith('{"this is"') && !message.value.includes('"bad"'),
    );
    expect(produced.length).toBeGreaterThanOrEqual(8);
    const seen = new Set<string>();
    for (const message of produced) {
      const value = JSON.parse(message.value) as { type: string };
      const validate = schemas.get(value.type);
      expect(validate, `no schema for ${value.type}`).toBeDefined();
      expect(validate?.(value), JSON.stringify(validate?.errors)).toBe(true);
      seen.add(value.type);
    }
    expect([...seen].sort()).toEqual([
      'FxRatePublished',
      'ProgramLimitSet',
      'ProgramReconciled',
      'RepaymentReceived',
    ]);
  });

  it('T1 schemas: malformed messages are rejected, including amounts with the wrong scale', async () => {
    const schemas = await validator();
    const at = { tenantId: 'bank-a', programId: 'p', seq: 1 };
    const bad = [
      JSON.parse(limitSet({ ...at, seq: 0 }, { value: '1.00', currency: 'USD' }).value),
      JSON.parse(limitSet(at, { value: '1.00', currency: 'usd' }).value),
      { ...JSON.parse(limitSet(at, { value: '1.00', currency: 'USD' }).value), schemaVersion: 2 },
      {
        ...JSON.parse(limitSet(at, { value: '1.00', currency: 'USD' }).value),
        messageId: undefined,
      },
    ] as { type: string }[];
    for (const value of bad) expect(schemas.get('ProgramLimitSet')?.(value)).toBe(false);
    expect(
      schemas.get('RepaymentReceived')?.(
        JSON.parse(
          repayment(at, {
            invoiceId: '',
            releaseRef: 'r',
            amount: { value: '1.00', currency: 'USD' },
          }).value,
        ),
      ),
    ).toBe(false);
    expect(
      schemas.get('ProgramReconciled')?.(
        JSON.parse(
          snapshot(at, {
            asOf: new Date(),
            creditLimit: { value: '1.00', currency: 'USD' },
            reservations: [],
          }).value,
        ),
      ),
    ).toBe(true);
    expect(
      schemas.get('FxRatePublished')?.(
        JSON.parse(fxRate({ base: 'EUR', quote: 'USD', rate: '1.1', asOf: new Date() }).value),
      ),
    ).toBe(true);
  });
});
