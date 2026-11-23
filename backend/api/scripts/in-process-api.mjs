// Boots the built API (`api:build`) in-process, over a throw-away sample content repository and an
// in-memory PGlite database (served on a loopback port the system picks; the API itself never
// listens), and hands the Nest application to a callback; everything is torn down afterwards.
// For scripts that need what the running server makes, such as its OpenAPI documents
// (`openapi-delivery.mjs`, `openapi-document.mjs`), without a server or a database to start.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const apiRequire = createRequire(join(apiRoot, 'package.json'));
const url = (path) => pathToFileURL(path).href;

/** Imports a module of the built API (`dist/`), e.g. `base/api/openapi.js`. */
export const importBuilt = (path) => import(url(join(apiRoot, 'dist', path)));

/**
 * Runs `use(app)` on the booted API and returns its result. `options.contentDir` serves that
 * content repository (the caller's to remove) instead of a fresh sample; `options.env` adds or
 * overrides settings (`CCMS_AUTH_MODE: 'demo'`, say) after the defaults below. `options.serve`
 * sets the app up as `main.ts` does for serving HTTP (request bodies, `x-powered-by` off), for a
 * caller that listens on it and sends it requests.
 */
export async function withInProcessApi(use, options = {}) {
  const { createSampleRepo } = await import(
    url(apiRequire.resolve('@openfolia/content-repo/testing'))
  );
  const sample =
    options.contentDir === undefined
      ? createSampleRepo()
      : { dir: options.contentDir, keep: true };
  const blobRoot = mkdtempSync(join(tmpdir(), 'openfolia-openapi-blobs-'));

  // The API connects to Postgres on boot: an in-memory PGlite on a loopback socket will do,
  // migrated as the server starts (it reads the stored secrets as it starts).
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

  for (const key of Object.keys(process.env))
    if (key.startsWith('CCMS_')) delete process.env[key];
  Object.assign(process.env, {
    CCMS_CONTENT_DIR: sample.dir,
    CCMS_API_TOKEN: 'openapi-delivery-0123456789abcdef0123456789abcdef',
    CCMS_DEFAULT_REF: 'main',
    CCMS_BLOB_DRIVER: 'fs',
    CCMS_BLOB_FS_ROOT: blobRoot,
    CCMS_DATABASE_URL: `postgres://postgres@${database.getServerConn()}/postgres`,
    // Migrated: starting reads the stored secrets (the secret key's check, #470).
    CCMS_DATABASE_MIGRATE: 'true',
    // A throwaway key, so no key file is made, never a checkout's own.
    CCMS_SECRET_KEY: randomBytes(32).toString('base64'),
    CCMS_WEBHOOKS_SECRET_KEY: '',
    // No outbox consumer on a database without tables.
    CCMS_NOTIFICATIONS_POLL_MS: '0',
    PORT: '0',
    ...options.env,
  });

  let app;
  try {
    apiRequire('reflect-metadata');
    const { NestFactory } = apiRequire('@nestjs/core');
    const { AppModule } = await importBuilt('app.module.js');
    // The job queue checks its schema on start (pg-boss's, not Drizzle's): install it.
    const { installJobQueue } = await importBuilt('jobs/repos/pg-boss-jobs.js');
    await installJobQueue({
      connectionString: process.env.CCMS_DATABASE_URL,
      max: 1,
    });
    app = await NestFactory.create(AppModule, { logger: false });
    if (options.serve) {
      const { setUpRequestBodies } = await importBuilt(
        'base/api/request-bodies.js',
      );
      app.disable('x-powered-by');
      setUpRequestBodies(app);
    }
    await app.init();
    return await use(app);
  } finally {
    await app?.close();
    await database.stop();
    await pglite.close();
    if (!sample.keep) rmSync(sample.dir, { recursive: true, force: true });
    rmSync(blobRoot, { recursive: true, force: true });
  }
}
