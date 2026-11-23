// Writes the API's full OpenAPI document (what `GET /openapi.json` serves) as JSON to the file
// given, for the docs site's API reference (`frontend/docs`, which keeps the operations outside the
// delivery API as the Management API). Not committed: made from this checkout's controllers and
// Zod schemas at build time, by booting the built API in-process (`in-process-api.mjs`).
//
//   node scripts/openapi-document.mjs <out.json>
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { importBuilt, withInProcessApi } from './in-process-api.mjs';

const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/openapi-document.mjs <out.json>');
  process.exit(2);
}

const document = await withInProcessApi(async (app) => {
  const { createOpenApiDocument } = await importBuilt('base/api/openapi.js');
  return createOpenApiDocument(app);
});
const target = resolve(out);
mkdirSync(dirname(target), { recursive: true });
// Through JSON, as the server serialises it.
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${target}`);
