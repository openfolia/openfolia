import { z } from 'zod';
import { CURRENT_IMPORT_FORMAT_VERSION, ImportDocument } from './format.js';
import '../schema-names.js';

/**
 * The JSON Schema (draft 2020-12) of `import.json`, generated from the Zod
 * schema: what a converter may write (the input side, so defaults are
 * optional). Published in the package as `import-format.schema.json`; a
 * test fails when the two drift.
 */
export function importFormatJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(ImportDocument, { io: 'input' }),
    title: `Import document, format version ${CURRENT_IMPORT_FORMAT_VERSION}`,
    description:
      'import.json at the root of an import bundle (a ZIP with import.json and assets/<sha256>). See docs/import-format.md in @openfolia/content-model.',
  };
}
