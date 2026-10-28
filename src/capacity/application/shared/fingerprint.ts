import { createHash } from 'node:crypto';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item as Json)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: Json };
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key] as Json)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the canonical JSON (sorted keys) of a request description. */
export function fingerprintOf(request: Json): string {
  return createHash('sha256').update(canonical(request)).digest('hex');
}
