// Generates `src/app/api/schema.d.ts` from the OpenAPI document of the real API.
//
//   node tools/generate-api-types.mjs          write the file
//   node tools/generate-api-types.mjs --check  fail when the committed file differs
//
// The document is not read from a running server: the built API (`api:build`) is booted
// in-process over a throw-away sample content repository and an in-memory PGlite database
// (the API never listens on a port; PGlite only on a loopback one), and
// its OpenAPI document is turned into types by openapi-typescript. So the types always
// match what the controllers and Zod schemas of the current checkout produce.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const target = join(root, 'frontend/editor/src/app/api/schema.d.ts');
const apiDist = join(root, 'backend/api/dist');
const apiRequire = createRequire(join(root, 'backend/api/package.json'));
const url = (path) => pathToFileURL(path).href;

const { createSampleRepo } = await import(
  url(join(root, 'packages/content-repo/dist/testing.js'))
);
const sample = createSampleRepo();

// The API connects to Postgres on boot: give it an in-memory PGlite (the
// API's test dependency) on a loopback socket, migrated as the server starts
// (it reads the stored secrets as it starts, #470).
const { PGlite } = apiRequire('@electric-sql/pglite');
// The migrations create pg_trgm (#54).
const { pg_trgm } = apiRequire('@electric-sql/pglite/contrib/pg_trgm');
const { PGLiteSocketServer } = apiRequire('@electric-sql/pglite-socket');
const pglite = await PGlite.create({ extensions: { pg_trgm } });
const database = new PGLiteSocketServer({
  db: pglite,
  host: '127.0.0.1',
  port: 0,
  maxConnections: 10,
});
await database.start();

Object.assign(process.env, {
  CCMS_CONTENT_DIR: sample.dir,
  CCMS_API_TOKEN: 'generate-api-types-0123456789abcdef0123456789',
  CCMS_DEFAULT_REF: 'main',
  CCMS_DATABASE_URL: `postgres://postgres@${database.getServerConn()}/postgres`,
  CCMS_DATABASE_MIGRATE: 'true',
  // A throwaway key, so no key file is made, never a checkout's own.
  CCMS_SECRET_KEY: randomBytes(32).toString('base64'),
  CCMS_WEBHOOKS_SECRET_KEY: '',
  PORT: '0',
});

let app;
let document;
try {
  apiRequire('reflect-metadata');
  const { NestFactory } = apiRequire('@nestjs/core');
  const { AppModule } = await import(url(join(apiDist, 'app.module.js')));
  const { createOpenApiDocument } = await import(
    url(join(apiDist, 'base/api/openapi.js'))
  );
  // The job queue checks its schema on start (pg-boss's, not Drizzle's): install it.
  const { installJobQueue } = await import(
    url(join(apiDist, 'jobs/repos/pg-boss-jobs.js'))
  );
  await installJobQueue({
    connectionString: process.env.CCMS_DATABASE_URL,
    max: 1,
  });
  app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  document = createOpenApiDocument(app);
} finally {
  await app?.close();
  await database.stop();
  await pglite.close();
  rmSync(sample.dir, { recursive: true, force: true });
}

const { default: openapiTS, astToString } = await import('openapi-typescript');
const header =
  "/**\n * Generated from the API's OpenAPI document by `tools/generate-api-types.mjs` (`nx run editor:api-types`).\n * Do not edit by hand: `nx run editor:check-api-types` fails when it drifts from the API.\n */\n\n";
const generated = header + astToString(await openapiTS(document));

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    // missing counts as drift
  }
  if (committed !== generated) {
    console.error(
      'The API client types are out of date with the API. Run `pnpm nx run editor:api-types` and commit the result.',
    );
    process.exit(1);
  }
  console.log('API client types match the API.');
} else {
  writeFileSync(target, generated);
  console.log(`Wrote ${target}`);
}
