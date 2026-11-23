import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, Module, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { ExpansionLimits } from '@openfolia/content-model';
import { createBareSampleRepo } from '@openfolia/content-repo/testing';
import { fromPglite } from 'pg-boss';
import request from 'supertest';
import { ResolveActorAction } from '../src/access/core/actions/resolve-actor.action.js';
import type { Actor } from '../src/access/core/actor.js';
import { UserDirectory } from '../src/access/core/user-directory.js';
import { JSON_API } from '../src/base/api/json-api.js';
import { BlobStore } from '../src/blobs/core/blob-store.js';
import { EXPANSION_LIMITS_TOKEN } from '../src/chunks/core/expansion-limits.js';
import { Database } from '../src/database/database.js';
import { JobWorker } from '../src/jobs/api/job-worker.js';
import { JobsConnection } from '../src/jobs/repos/pg-boss-jobs.js';
import { StyleReviewer } from '../src/style-review/core/style-reviewer.js';
import { TranslationJobs } from '../src/translations/core/translation-jobs.js';
import { createTestDatabase, PgliteDatabase } from './database.js';

export const TOKEN = 'test-token-0123456789abcdef0123456789';

/** The instance secret key in tests (32 bytes, hex): never a real one. */
export const TEST_SECRET_KEY = '00'.repeat(32);

export interface TestApp {
  app: INestApplication;
  commits: ReturnType<typeof createBareSampleRepo>['commits'];
  /** The app's database: a fresh in-memory PGlite with every migration applied. */
  database: Database;
  /** The app's blob store: a fresh folder (`FsBlobStore`), or `options.blobs`. */
  blobs: BlobStore;
  /**
   * Runs every background job that is due, one after the other, until none
   * is left, and says how many ran (`JobWorker.drain`): the app runs no
   * jobs on a timer (`CCMS_JOBS_POLL_MS=0`).
   */
  runJobs: () => Promise<number>;
  /** A request with the API token. */
  get: (path: string) => request.Test;
  /** A POST with the API token; send a body with `.send(…)` (as JSON:API). */
  post: (path: string) => request.Test;
  /** A PUT with the API token; send a body with `.send(…)` (as JSON:API). */
  put: (path: string) => request.Test;
  /** A PATCH with the API token; send a body with `.send(…)` (as JSON:API). */
  patch: (path: string) => request.Test;
  /** A DELETE with the API token (and the JSON:API media type, which every state-changing request needs). */
  delete: (path: string) => request.Test;
  /** A request without any token. */
  anonymous: () => ReturnType<typeof request>;
  /**
   * Sets the actor of the following requests (`request.actor`, read by
   * `@CurrentActor()`), standing in for actor resolution: the guard still
   * checks the token, then takes this actor instead of resolving one.
   * `undefined` (the default) resolves as the app does. Tests only.
   */
  actAs: (actor: Actor | undefined) => void;
  close: () => Promise<void>;
}

/**
 * The real application (all modules, guards, filters and pipes) over a
 * bare sample repository and a fresh PGlite database (or `options.database`,
 * e.g. one whose `ping` fails). Settings are passed through the
 * environment, as in production; the module is imported afterwards because
 * `ConfigModule` reads the environment when it is loaded.
 * `CCMS_DATABASE_URL` only has to be valid: the database replaces the
 * Postgres connection, so nothing connects to it.
 */
export async function createTestApp(
  env: Record<string, string> = {},
  options: {
    database?: Database;
    blobs?: BlobStore;
    /** In place of the app's (none at a provider until #50). */
    translationJobs?: TranslationJobs;
    /** In place of the app's (off unless `CCMS_STYLE_REVIEW_URL` is set). */
    styleReviewer?: StyleReviewer;
    /**
     * The limits of #679 the chunks and the checks cut to, in place of the content model's
     * `EXPANSION_LIMITS` (#726): so a spec crosses them with content about a hundred times smaller.
     * Only here: the app itself never provides them.
     */
    expansionLimits?: ExpansionLimits;
    /** Extra modules (e.g. one providing a test's `JobHandler`). */
    imports?: NonNullable<
      Parameters<typeof Test.createTestingModule>[0]['imports']
    >;
  } = {},
): Promise<TestApp> {
  const sample = createBareSampleRepo();
  const blobRoot = mkdtempSync(join(tmpdir(), 'openfolia-test-blobs-'));
  const removeFolders = () => {
    rmSync(sample.dir, { recursive: true, force: true });
    rmSync(blobRoot, { recursive: true, force: true });
  };
  let actor: Actor | undefined;
  let database: Database | undefined;
  /** pg-boss's database: the app's PGlite, or one of its own beside a database that is not one. */
  let jobsDatabase: PgliteDatabase | undefined;
  let ownJobsDatabase = false;
  let app: NestExpressApplication | undefined;
  try {
    database = options.database ?? (await createTestDatabase());
    if (database instanceof PgliteDatabase) {
      jobsDatabase = database;
    } else {
      jobsDatabase = await createTestDatabase();
      ownJobsDatabase = true;
    }
    Object.assign(process.env, {
      CCMS_CONTENT_DIR: sample.dir,
      CCMS_API_TOKEN: TOKEN,
      CCMS_DEFAULT_REF: 'main',
      // Nx hands tasks the checkout's local settings, where setup-local writes demo mode: a test
      // asks for demo mode itself.
      CCMS_AUTH_MODE: 'token',
      CCMS_DATABASE_URL: 'postgres://unused@127.0.0.1:9/unused',
      CCMS_BLOB_DRIVER: 'fs',
      CCMS_BLOB_FS_ROOT: blobRoot,
      // The notifications' fan-out runs when a test asks (`NotificationsConsumer.runOnce`),
      // not on a timer under every other test.
      CCMS_NOTIFICATIONS_POLL_MS: '0',
      // Every test client shares one address, and many tests send no token on
      // purpose: the limit on failed authentications only where a test asks.
      CCMS_AUTH_FAILURES_MAX: '0',
      // Background jobs run when a test asks (`t.runJobs()`).
      CCMS_JOBS_POLL_MS: '0',
      // A release's offline packages (#59) only where a test asks for them: the other tests
      // count and list a release's PDFs.
      CCMS_OFFLINE_PACKAGES: 'false',
      // The style review is off unless a test sets it up (never a checkout's own endpoint).
      CCMS_STYLE_REVIEW_URL: '',
      CCMS_STYLE_REVIEW_MODEL: '',
      CCMS_STYLE_REVIEW_API_KEY: '',
      CCMS_STYLE_REVIEW_PER_MINUTE: '',
      CCMS_STYLE_REVIEW_TIMEOUT_MS: '',
      // The search's limits (#539) are their defaults unless a test sets them (never a checkout's own).
      CCMS_SEARCH_PER_MINUTE: '',
      CCMS_SEARCH_TIMEOUT_MS: '',
      CCMS_SEARCH_CONCURRENCY: '',
      // A fixed secret key (so no key file is made), never a checkout's own; a
      // test of the key file or of its old name sets these itself.
      CCMS_SECRET_KEY: TEST_SECRET_KEY,
      CCMS_WEBHOOKS_SECRET_KEY: '',
      CCMS_SECRET_KEY_FILE: '',
      CCMS_SECRET_KEY_GENERATE: '',
      // Webhooks read the outbox when a test asks (`WebhooksConsumer.runOnce`),
      // and send only where the rules allow: https and public addresses,
      // unless a test relaxes them for its local receiver.
      CCMS_WEBHOOKS_POLL_MS: '0',
      CCMS_WEBHOOKS_ALLOW_HTTP: '',
      CCMS_WEBHOOKS_ALLOW_PRIVATE: '',
      CCMS_WEBHOOKS_TIMEOUT_MS: '',
      CCMS_WEBHOOKS_KEEP_DAYS: '',
      // No email unless a test sets up its own mail server (never a checkout's own).
      CCMS_MAIL_URL: '',
      CCMS_MAIL_USER: '',
      CCMS_MAIL_PASSWORD: '',
      CCMS_MAIL_PASSWORD_FILE: '',
      CCMS_MAIL_FROM: '',
      CCMS_MAIL_REQUIRE_TLS: '',
      CCMS_MAIL_CA_FILE: '',
      CCMS_MAIL_LANGUAGE: '',
      // The audit log goes to no sink and is kept for ever unless a test sets these
      // (never a checkout's own); a test delivers by `AuditSinkConsumer.runOnce`.
      CCMS_AUDIT_SINK_URL: '',
      CCMS_AUDIT_SINK_SECRET: '',
      CCMS_AUDIT_SINK_CA_FILE: '',
      CCMS_AUDIT_SINK_POLL_MS: '0',
      CCMS_AUDIT_SINK_TIMEOUT_MS: '',
      CCMS_AUDIT_KEEP_DAYS: '',
      // Never a checkout's own setting: a test sets it.
      CCMS_SOURCE_URL: '',
      CCMS_PUBLIC_URL: '',
      CCMS_DELIVERY_MAX_ACCESS: '',
      CCMS_DELIVERY_IGNORED_QUERY: '',
      // Every test client shares one address: the stable addresses' rate limit (#574) only
      // where a test asks, and no proxy trusted unless a test names one.
      CCMS_DELIVERY_PER_MINUTE: '0',
      CCMS_TRUST_PROXY: '',
      // No storage limit unless a test sets one (never a checkout's own).
      CCMS_STORAGE_LIMIT_BYTES: '',
      CCMS_STORAGE_RECOUNT_HOURS: '',
      // Sign-in (#37) is off unless a test sets it up (never a checkout's own provider).
      CCMS_OIDC_ISSUER: '',
      CCMS_OIDC_CLIENT_ID: '',
      CCMS_OIDC_CLIENT_SECRET: '',
      CCMS_OIDC_REDIRECT_URL: '',
      CCMS_OIDC_SCOPES: '',
      CCMS_OIDC_GROUPS_CLAIM: '',
      CCMS_OIDC_NAME: '',
      CCMS_OIDC_LINK_BY_EMAIL: '',
      CCMS_EDITOR_URL: '',
      CCMS_SESSION_IDLE_MINUTES: '',
      CCMS_SESSION_MAX_HOURS: '',
      // Password sign-in (#610) is off unless a test turns it on (the shared token's tests act
      // without sessions, and a cookie would vary every answer).
      CCMS_PASSWORD_SIGN_IN: 'off',
      CCMS_INVITE_DAYS: '',
      // No first admin from the environment (#373) unless a test sets one.
      CCMS_FIRST_ADMIN_EMAIL: '',
      CCMS_FIRST_ADMIN_NAME: '',
      CCMS_FIRST_ADMIN_LINK_LOG: '',
      // Every role's behaviour in one process, as a single-process setup (#527); a test of a role sets it.
      CCMS_ROLE: '',
      ...env,
    });
    const { AppModule } = await import('../src/app.module.js');
    const { setUpOpenApi } = await import('../src/base/api/openapi.js');
    const { setUpRequestBodies } =
      await import('../src/base/api/request-bodies.js');
    const { setUpTrustProxy } = await import('../src/base/api/trust-proxy.js');
    let testing = Test.createTestingModule({
      imports: [
        AppModule,
        ...(options.expansionLimits
          ? [expansionLimitsModule(options.expansionLimits)]
          : []),
        ...(options.imports ?? []),
      ],
    })
      .overrideProvider(Database)
      .useValue(database)
      // pg-boss runs on PGlite through its own adapter; the schema is in the template.
      .overrideProvider(JobsConnection)
      .useValue({
        options: {
          db: fromPglite(jobsDatabase.client),
          backend: 'pglite',
          // Maintenance (heartbeat expiry, clean-up) runs when a test calls `supervise()`.
          supervise: false,
          registerInstance: false,
        },
        migrate: true,
      } satisfies JobsConnection);
    if (options.blobs) {
      testing = testing.overrideProvider(BlobStore).useValue(options.blobs);
    }
    if (options.translationJobs) {
      testing = testing
        .overrideProvider(TranslationJobs)
        .useValue(options.translationJobs);
    }
    if (options.styleReviewer) {
      testing = testing
        .overrideProvider(StyleReviewer)
        .useValue(options.styleReviewer);
    }
    const moduleRef = await testing
      // The guard asks it only after the token checked out.
      .overrideProvider(ResolveActorAction)
      .useFactory({
        inject: [UserDirectory],
        factory: (users: UserDirectory) => {
          const real = new ResolveActorAction(users);
          return {
            handle: async (
              input: Parameters<ResolveActorAction['handle']>[0],
            ) => (actor ? { actor } : real.handle(input)),
          };
        },
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    setUpTrustProxy(app);
    setUpRequestBodies(app);
    setUpOpenApi(app);
    await app.init();
  } catch (error) {
    // Setup failed: release what it made, then report only its error. (A
    // hook timeout does not land here: setup goes on in the background, and
    // the spec's teardown skips the app it never got.)
    await app?.close().catch(() => undefined);
    if (!options.database) await database?.close().catch(() => undefined);
    if (ownJobsDatabase) await jobsDatabase?.close().catch(() => undefined);
    removeFolders();
    throw error;
  }
  const started = app;
  return {
    app: started,
    commits: sample.commits,
    database,
    blobs: started.get(BlobStore),
    runJobs: () => started.get(JobWorker).drain(),
    get: (path) =>
      request(started.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${TOKEN}`),
    post: (path) =>
      request(started.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Content-Type', JSON_API),
    put: (path) =>
      request(started.getHttpServer())
        .put(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Content-Type', JSON_API),
    patch: (path) =>
      request(started.getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Content-Type', JSON_API),
    delete: (path) =>
      request(started.getHttpServer())
        .delete(path)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Content-Type', JSON_API),
    anonymous: () => request(started.getHttpServer()),
    actAs: (next) => {
      actor = next;
    },
    close: async () => {
      try {
        // Closes the database too (DatabaseModule's shutdown hook).
        await started.close();
      } finally {
        if (ownJobsDatabase) await jobsDatabase?.close().catch(() => undefined);
        removeFolders();
      }
    },
  };
}

/** A global module providing `limits` at `EXPANSION_LIMITS_TOKEN` (`createTestApp`). */
function expansionLimitsModule(limits: ExpansionLimits) {
  @Global()
  @Module({
    providers: [{ provide: EXPANSION_LIMITS_TOKEN, useValue: limits }],
    exports: [EXPANSION_LIMITS_TOKEN],
  })
  class ExpansionLimitsModule {}
  return ExpansionLimitsModule;
}
