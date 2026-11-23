// Writes the delivery API's OpenAPI document to `openapi/delivery.yaml`, the file a consumer
// publishes, generates a client from or diffs in a pull request.
//
//   node scripts/openapi-delivery.mjs          write the file
//   node scripts/openapi-delivery.mjs --check  fail when the committed file differs
//
// The document is not read from a running server: the built API (`api:build`) is booted in-process
// (`in-process-api.mjs`: a throw-away sample content repository, an in-memory PGlite database, no
// port), and the document is made by the same code that serves `/openapi/delivery.yaml`, so the
// file matches the controllers and Zod schemas of this checkout.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  apiRequire,
  apiRoot,
  importBuilt,
  withInProcessApi,
} from './in-process-api.mjs';

const target = join(apiRoot, 'openapi/delivery.yaml');

const document = await withInProcessApi(async (app) => {
  const { createDeliveryDocument } = await importBuilt('base/api/openapi.js');
  return createDeliveryDocument(app);
});

// The same serialisation as the server's `/openapi/delivery.yaml`.
const swaggerRequire = createRequire(apiRequire.resolve('@nestjs/swagger'));
const generated = swaggerRequire('js-yaml').dump(document, {
  skipInvalid: true,
  noRefs: true,
});

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    // missing counts as drift
  }
  if (committed !== generated) {
    console.error(
      'backend/api/openapi/delivery.yaml is out of date with the API. Run `pnpm nx run api:openapi-delivery` and commit the result.',
    );
    process.exit(1);
  }
  console.log('The delivery OpenAPI file matches the API.');
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, generated);
  console.log(`Wrote ${target}`);
}
