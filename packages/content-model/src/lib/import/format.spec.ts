import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDocument } from '../../fixtures/import-example.js';
import { ImportDocument } from './format.js';
import { importFormatJsonSchema } from './json-schema.js';

const packageRoot = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(packageRoot, path), 'utf8');

/** Every property name the schema declares, anywhere in it. */
function propertyNames(
  schema: unknown,
  names = new Set<string>(),
): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) propertyNames(s, names);
  } else if (typeof schema === 'object' && schema !== null) {
    const { properties } = schema as { properties?: unknown };
    if (typeof properties === 'object' && properties !== null)
      for (const name of Object.keys(properties)) names.add(name);
    for (const value of Object.values(schema)) propertyNames(value, names);
  }
  return names;
}

describe('the import format', () => {
  it('publishes the JSON Schema generated from the Zod schema', () => {
    // On a mismatch: `pnpm nx run content-model:import-schema` writes it again.
    expect(JSON.parse(read('import-format.schema.json'))).toEqual(
      importFormatJsonSchema(),
    );
  });

  it('documents every field the schema has', () => {
    const doc = read('docs/import-format.md');
    const missing = [...propertyNames(importFormatJsonSchema())].filter(
      (name) => !doc.includes(`\`${name}\``),
    );
    expect(missing).toEqual([]);
  });

  it('parses the example bundle with the published schema', () => {
    const parsed = ImportDocument.parse(exampleDocument());
    expect(parsed.modules).toHaveLength(3);
    expect(parsed.manuals.map((m) => m.id)).toEqual(['pump-guide']);
  });
});
