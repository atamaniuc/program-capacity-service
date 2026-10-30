import { compareSchemas } from './compare-schemas.js';

/** Event schema files by path relative to `json-schema/` (for example `capacity.events.v1/X.schema.json`) → parsed schema. */
export type SchemaSet = ReadonlyMap<string, object>;

/**
 * CT-04, the build-time substitute for a schema registry (ADR 028): every schema of the base must
 * still exist and accept what it accepted. Removing or renaming a field, adding a required one or
 * narrowing a type is reported; a new optional field or a new schema file is not.
 */
export function incompatibleChanges(base: SchemaSet, current: SchemaSet): string[] {
  const problems: string[] = [];
  for (const [path, before] of base) {
    const now = current.get(path);
    if (now === undefined) {
      problems.push(`${path}: schema removed`);
      continue;
    }
    for (const problem of compareSchemas(before, now)) problems.push(`${path}: ${problem}`);
  }
  return problems;
}
