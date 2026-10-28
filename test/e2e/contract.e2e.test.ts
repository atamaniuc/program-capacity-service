/* eslint-disable @typescript-eslint/no-unsafe-member-access -- response bodies are parsed JSON */
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { default as addFormatsModule } from 'ajv-formats';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderOpenApiYaml } from '../../tools/contracts/render.js';
import { startTestApp, type TestApp } from '../support/app.js';

describe('contract', () => {
  let app: TestApp;
  let validate: (schema: string, value: unknown) => string | null;
  let document: {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };

  beforeAll(async () => {
    app = await startTestApp();
    await sql`INSERT INTO program (tenant_id, id, currency, credit_limit_minor)
              VALUES ('bank-a', 'prg', 'USD', 1000000000)`.execute(app.persistence.db);
    await sql`INSERT INTO fx_rate (base, quote, rate, source, as_of)
              VALUES ('EUR', 'USD', 1.08, 'treasury', now())`.execute(app.persistence.db);

    const { buildOpenApiDocument } = await import('#src/capacity/adapters/in/http/openapi.js');
    document = JSON.parse(JSON.stringify(buildOpenApiDocument())) as typeof document;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
    addFormats(ajv);
    ajv.addSchema({ $id: 'api', components: document.components });
    validate = (schema, value) => {
      const check = ajv.getSchema(`api#/components/schemas/${schema}`);
      if (check === undefined) throw new Error(`no component schema ${schema}`);
      return check(value) ? null : ajv.errorsText(check.errors);
    };
  });

  afterAll(async () => {
    await app.stop();
  });

  it('openapi: contracts/openapi.yaml matches the schemas generated from zod', async () => {
    const committed = await readFile(
      new URL('../../contracts/openapi.yaml', import.meta.url),
      'utf8',
    );
    expect(committed).toBe(renderOpenApiYaml());
  });

  it('openapi: real responses validate against the generated component schemas', async () => {
    const capacity = await app.request('GET', '/v1/programs/prg/capacity');
    expect(validate('Capacity', capacity.body)).toBeNull();

    const created = await app.request('POST', '/v1/programs/prg/reservations', {
      body: { invoiceId: 'INV-1', amount: { value: '100.00', currency: 'EUR' } },
    });
    expect(created.status).toBe(201);
    expect(validate('Reservation', created.body)).toBeNull();

    const base = `/v1/programs/prg/reservations/${created.body.reservationId}`;
    const released = await app.request('POST', `${base}/releases`, {
      body: { releaseRef: 'a', amount: { value: '10.00', currency: 'EUR' }, reason: 'REPAID' },
    });
    expect(released.status).toBe(200);
    expect(validate('Release', released.body)).toBeNull();

    const detail = await app.request('GET', base);
    expect(validate('ReservationDetail', detail.body)).toBeNull();

    for (const response of [
      await app.request('GET', '/v1/programs/missing/capacity'),
      await app.request('POST', '/v1/programs/prg/reservations', { body: { nope: true } }),
      await app.request('POST', '/v1/programs/prg/reservations', {
        body: { invoiceId: 'INV-1', amount: { value: '1.00', currency: 'EUR' } },
      }),
      await app.request('GET', '/v1/programs/prg/capacity', { token: null }),
    ]) {
      expect(validate('Problem', response.body)).toBeNull();
    }

    expect(validate('Capacity', { ...capacity.body, version: 'one' })).not.toBeNull();
    expect(validate('Reservation', { ...created.body, status: 'LOST' })).not.toBeNull();
  });

  it('openapi: every documented path is served and the docs live on the ops port only', async () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      '/v1/programs/{programId}/capacity',
      '/v1/programs/{programId}/reservations',
      '/v1/programs/{programId}/reservations/{reservationId}',
      '/v1/programs/{programId}/reservations/{reservationId}/releases',
    ]);
    const onOps = await fetch(`${app.opsUrl}/docs/openapi.json`);
    expect(onOps.status).toBe(200);
    expect(((await onOps.json()) as { openapi: string }).openapi).toBe('3.1.0');
    expect((await fetch(`${app.opsUrl}/docs`)).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/docs`)).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/docs/openapi.json`)).status).toBe(404);
  });
});
