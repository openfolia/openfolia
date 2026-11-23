import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOpenAPI } from 'fumadocs-openapi/server';

/**
 * The API reference's documents: one small document per operation (`generated/openapi/index.json`,
 * made by `scripts/generate.mjs` from the API's own documents), so each page embeds only the
 * operation it shows and the schemas it references.
 */
const root = process.cwd();
const index = JSON.parse(
  readFileSync(join(root, 'generated/openapi/index.json'), 'utf8'),
) as Record<string, string>;

export const openapi = createOpenAPI({
  input: Object.fromEntries(
    Object.entries(index).map(([id, file]) => [id, join(root, file)]),
  ),
});
