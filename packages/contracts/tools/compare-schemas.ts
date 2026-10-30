/**
 * Breaking-change check for the JSON Schemas of the Kafka messages (NFR-14, ADR 015). The rule
 * is deliberately narrow, because both directions matter: treasury produces what we validate,
 * consumers validate what we produce. Within v1 the only allowed changes are:
 * - a new optional property;
 * - a new value of the `event-type` header (consumers skip event types they do not know);
 * - documentation: `description`, `title`, `examples`, `$schema`.
 * Anything else (a removed or newly required property, a changed type, enum, pattern, bound or
 * format) is reported. `$ref`/`$defs`/`definitions` are inlined first, so a layout change of the
 * file is not mistaken for a contract change.
 */

type Json = Record<string, unknown>;

const DOCS = new Set(['description', 'title', 'examples', 'example', '$schema']);
const OPEN_ENUMS = new Set(['event-type']);

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function inline(node: unknown, root: Json): unknown {
  if (Array.isArray(node)) return node.map((item) => inline(item, root));
  if (!isObject(node)) return node;
  const { $ref, ...rest } = node;
  const own = Object.fromEntries(
    Object.entries(rest)
      .filter(([key]) => key !== '$defs' && key !== 'definitions')
      .map(([key, value]) => [key, inline(value, root)]),
  );
  if (typeof $ref !== 'string') return own;
  const target = $ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((at, key) => (isObject(at) ? at[key] : undefined), root);
  if (target === undefined) throw new Error(`unresolved $ref ${$ref}`);
  return { ...(inline(target, root) as Json), ...own };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function walk(before: unknown, after: unknown, path: string, out: string[]): void {
  if (!isObject(before) || !isObject(after)) {
    if (!same(before, after)) out.push(`${path}: changed`);
    return;
  }
  const beforeProps = isObject(before['properties']) ? before['properties'] : {};
  const afterProps = isObject(after['properties']) ? after['properties'] : {};
  const beforeRequired = new Set((before['required'] as string[] | undefined) ?? []);
  const afterRequired = new Set((after['required'] as string[] | undefined) ?? []);
  for (const [name, schema] of Object.entries(beforeProps)) {
    if (!(name in afterProps)) out.push(`${path}.${name}: removed`);
    else walk(schema, afterProps[name], `${path}.${name}`, out);
    if (beforeRequired.has(name) && !afterRequired.has(name)) {
      out.push(`${path}.${name}: no longer required`);
    }
  }
  for (const name of afterRequired) {
    if (!beforeRequired.has(name)) out.push(`${path}.${name}: newly required`);
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (DOCS.has(key) || key === 'properties' || key === 'required') continue;
    const a = before[key];
    const b = after[key];
    if (key === 'enum' && OPEN_ENUMS.has(path.split('.').pop() ?? '')) {
      const missing = ((a as unknown[] | undefined) ?? []).filter(
        (value) => !((b as unknown[] | undefined) ?? []).includes(value),
      );
      if (missing.length > 0) out.push(`${path}: enum lost ${missing.join(', ')}`);
    } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && key !== 'enum') {
      a.forEach((item, index) => {
        walk(item, b[index], `${path}.${key}[${index}]`, out);
      });
    } else if (isObject(a) && isObject(b)) {
      walk(a, b, `${path}.${key}`, out);
    } else if (!same(a, b)) {
      out.push(`${path}: ${key} ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
  }
}

/** Every breaking difference from `before` to `after`; empty when `after` is compatible. */
export function compareSchemas(before: object, after: object): string[] {
  const out: string[] = [];
  walk(inline(before, before as Json), inline(after, after as Json), '$', out);
  return out;
}
