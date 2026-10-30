import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { incompatibleChanges } from '../tools/event-schemas.js';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const schemaDir = join(pkg, 'json-schema');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const base = {
  type: 'object',
  properties: { id: { type: 'string' }, amount: { type: 'string' }, note: { type: 'string' } },
  required: ['id', 'amount'],
};
const one = (schema: object) => new Map([['capacity.events.v1/E.schema.json', schema]]);
const changes = (next: object) => incompatibleChanges(one(base), one(next));

describe('event schema backward compatibility', () => {
  it('CT-04 passes an unchanged schema and an added optional field', () => {
    expect(changes(base)).toEqual([]);
    const added = { ...base, properties: { ...base.properties, extra: { type: 'string' } } };
    expect(changes(added)).toEqual([]);
  });

  it('CT-04 passes a new schema file', () => {
    const current = new Map([...one(base), ['funding.events.v1/N.schema.json', base]]);
    expect(incompatibleChanges(one(base), current)).toEqual([]);
  });

  it('CT-04 refuses removing a field', () => {
    const rest = { id: base.properties.id, amount: base.properties.amount };
    expect(changes({ ...base, properties: rest })).not.toEqual([]);
  });

  it('CT-04 refuses renaming a field', () => {
    const { note, ...rest } = base.properties;
    expect(changes({ ...base, properties: { ...rest, remark: note } })).not.toEqual([]);
  });

  it('CT-04 refuses adding a required field', () => {
    const next = {
      ...base,
      properties: { ...base.properties, extra: { type: 'string' } },
      required: [...base.required, 'extra'],
    };
    expect(changes(next)).not.toEqual([]);
  });

  it('CT-04 refuses narrowing a type', () => {
    const next = { ...base, properties: { ...base.properties, amount: { type: 'string', maxLength: 5 } } };
    expect(changes(next)).not.toEqual([]);
    const other = { ...base, properties: { ...base.properties, amount: { type: 'integer' } } };
    expect(changes(other)).not.toEqual([]);
  });

  it('CT-04 refuses a removed schema file', () => {
    expect(incompatibleChanges(one(base), new Map())).toEqual([
      'capacity.events.v1/E.schema.json: schema removed',
    ]);
  });

  it('CT-04 the committed schemas are compatible with HEAD, and both topics are present', () => {
    const topics = readdirSync(schemaDir).sort();
    expect(topics).toEqual(['capacity.events.v1', 'funding.events.v1']);
    const run = spawnSync(join(pkg, '../../node_modules/.bin/tsx'), ['tools/schema-compat.ts'], {
      cwd: pkg,
      encoding: 'utf8',
      env: { ...process.env, SCHEMA_BASE: '' },
    });
    expect(run.stderr.replace(/npm warn.*\n/g, ''), run.stdout).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('breaking=0');
  });

  it('CT-04 every committed event schema compiles as JSON Schema draft-07', () => {
    const ajv = new Ajv({ strict: false });
    const all = files(schemaDir).filter((f) => f.endsWith('.schema.json'));
    expect(all.length).toBeGreaterThan(8);
    for (const file of all) {
      expect(() => ajv.compile(JSON.parse(readFileSync(file, 'utf8')) as object), file).not.toThrow();
    }
  });
});
