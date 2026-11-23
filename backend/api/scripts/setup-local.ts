/**
 * Prepares local testing: a bare sample content repository in `.local/`
 * (bare, so the API can write branches to it: nothing is checked out) and
 * a `.env.local` pointing the API at it, with a fresh random token, and at
 * the compose Postgres and S3 service (`docker compose up -d`, `compose.yaml`). Both files
 * are git-ignored. Existing files are kept, so the token stays stable; a
 * setting added since is appended to an existing `.env.local`. Pass
 * `--force` to recreate both. When Postgres answers, the database is
 * created if it is missing, and so is the blob store's bucket when the S3
 * service answers (`local-bucket.ts`).
 *
 * A local run starts usable: signing in with a password (#610), `CCMS_AUTH_MODE=token` (added
 * when the file has no value for it; a value the person set is kept). Into a local database
 * without users, it makes the first admin (`admin@example.com`, `api:first-admin`) and prints
 * the one-time link to choose their password. With `CCMS_AUTH_MODE=demo` (the demo and the
 * editor's e2e stack), the example roles and users are seeded (`db-seed --example`) instead,
 * so the editor's sign-in page lists them.
 *
 *   pnpm nx run api:setup-local
 *   pnpm nx run api:serve-local
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  addSampleRtlLanguages,
  addSamplePageDesigns,
  addSampleTemplates,
  addSampleNoticeLeaflet,
  addSampleSafetyLeaflet,
  addSampleSnippets,
  addSampleTerms,
  createBareSampleRepo,
} from '@openfolia/content-repo/testing';
import { SAMPLE_TEMPLATES } from '@openfolia/render-typst';
import pg from 'pg';
import { ensureBucket, LOCAL_S3, localBucket } from './local-bucket.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const contentDir = join(root, '.local', 'sample-content.git');
/** Where earlier versions made the sample, with a working tree the API cannot write through. */
const oldContentDir = join(root, '.local', 'sample-content');
const envFile = join(root, '.env.local');
const force = process.argv.includes('--force');
const apiDir = join(import.meta.dirname, '..');
/**
 * Settings `.env.example` carries without a value: an empty line there was
 * copied from it, not chosen, so it is filled in place like a missing one.
 */
const FILL_WHEN_EMPTY = ['CCMS_AUTH_MODE'];

/**
 * One database per checkout on the shared compose Postgres: `ccms` for the
 * main checkout, `ccms_<slot>` for an agent slot (`.claude/worktrees/<slot>`),
 * so a branch's unmerged migration never reaches another checkout's data. Kept in step with
 * `apiDatabaseName` in `scripts/slot-databases-plan.mjs`, by which `pnpm slot remove` drops the
 * slot's own (a project can't import another by path; `slot-databases.test.ts` pins the two).
 * Compatibility: keeps the working name from before the product was named OpenFolia, as every
 * database name: databases already made stay in use.
 */
const inSlot =
  basename(dirname(root)) === 'worktrees' &&
  basename(dirname(dirname(root))) === '.claude';
const databaseName = inSlot
  ? `ccms_${basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')}`
  : 'ccms';
/**
 * A slot's database says which main checkout's tooling made it (`COMMENT ON DATABASE`), so
 * `pnpm slot remove` and `prune-databases` never take another clone's, or one made by hand,
 * for this checkout's: `ownerComment` in `scripts/slot-databases-plan.mjs`, pinned by its test.
 */
const ownerComment = inSlot
  ? `ccms-checkout:${dirname(dirname(dirname(realpathSync(root))))}`
  : undefined;

if (force) rmSync(contentDir, { recursive: true, force: true });
if (existsSync(contentDir)) {
  console.log(`Sample content: kept ${relative(root, contentDir)}`);
} else {
  createBareSampleRepo(contentDir);
  // Two snippets on main (a snippet type in the configuration), for the snippet suggestions.
  await addSampleSnippets(contentDir);
  // Terms, and a module using a forbidden variant of one, for the terminology.
  await addSampleTerms(contentDir);
  // Arabic and Hebrew, a module translated into both and a manual of it (#458).
  await addSampleRtlLanguages(contentDir);
  // Two page designs (#390), for `GET /page-designs`.
  await addSamplePageDesigns(contentDir);
  // The example template and one that does not compile (#396), for a design to name.
  addSampleTemplates(contentDir, SAMPLE_TEMPLATES);
  // A safety type, two safety modules and a safety leaflet derived from the operating manual (#451).
  await addSampleSafetyLeaflet(contentDir);
  // A leaflet of the operating manual's safety notices, grouped by hazard level (#670).
  await addSampleNoticeLeaflet(contentDir);
  console.log(
    `Sample content: created ${relative(root, contentDir)} (bare; branches main and draft, tag v1; snippets, terms, right-to-left languages, page designs and templates, a safety leaflet and a leaflet of safety notices on main)`,
  );
}

const values: Record<string, string> = {
  CCMS_CONTENT_DIR: contentDir,
  CCMS_API_TOKEN: randomBytes(32).toString('hex'),
  CCMS_DEFAULT_REF: 'main',
  // Signing in with a password (#610); `demo` lists the seeded example users instead.
  CCMS_AUTH_MODE: 'token',
  // Two workers are plenty locally and keep memory use low.
  CCMS_PDF_WORKERS: '2',
  // The compose Postgres (compose.yaml); local credentials only.
  CCMS_DATABASE_URL: `postgres://ccms:ccms@127.0.0.1:5432/${databaseName}`,
  // The compose S3 service (compose.yaml), a bucket per checkout; local credentials only.
  CCMS_BLOB_DRIVER: 's3',
  CCMS_S3_ENDPOINT: LOCAL_S3.endpoint,
  CCMS_S3_REGION: LOCAL_S3.region,
  CCMS_S3_BUCKET: localBucket(root),
  CCMS_S3_ACCESS_KEY_ID: LOCAL_S3.accessKeyId,
  CCMS_S3_SECRET_ACCESS_KEY: LOCAL_S3.secretAccessKey,
  CCMS_S3_FORCE_PATH_STYLE: 'true',
  // Webhooks delivering to a receiver on this machine (local runs only). Their secrets are sealed
  // under the key the API makes on its first start, beside the sample content (.local/ccms-secret.key).
  CCMS_WEBHOOKS_ALLOW_HTTP: 'true',
  CCMS_WEBHOOKS_ALLOW_PRIVATE: 'true',
};

if (existsSync(envFile) && !force) {
  // Still pointing at the old sample with a working tree: moved to the bare one.
  const before = readFileSync(envFile, 'utf8');
  const oldLine = `CCMS_CONTENT_DIR=${oldContentDir}`;
  const moved = before
    .split('\n')
    .map((line) =>
      line.trim() === oldLine ? `CCMS_CONTENT_DIR=${contentDir}` : line,
    )
    .join('\n');
  if (moved !== before) {
    writeFileSync(envFile, moved, { mode: 0o600 });
    console.log(
      `Settings: CCMS_CONTENT_DIR moved to ${relative(root, contentDir)} (bare); ${relative(root, oldContentDir)} is no longer used and can be deleted`,
    );
  }
  // An empty line copied from the example (`CCMS_AUTH_MODE=`): filled in place.
  const unfilled = readFileSync(envFile, 'utf8');
  const emptyLine = (name: string) => new RegExp(`^${name}=[ \\t]*$`, 'm');
  const filled = FILL_WHEN_EMPTY.filter((name) =>
    emptyLine(name).test(unfilled),
  );
  if (filled.length > 0) {
    writeFileSync(
      envFile,
      filled.reduce(
        (text, name) =>
          text.replace(emptyLine(name), `${name}=${values[name]}`),
        unfilled,
      ),
      { mode: 0o600 },
    );
    console.log(
      `Settings: set ${filled.map((name) => `${name}=${values[name]}`).join(', ')} in .env.local (it was empty)`,
    );
  }
  // Settings added since the file was made: appended with their values.
  const kept = readFileSync(envFile, 'utf8');
  const missing = Object.keys(values).filter(
    (name) => !new RegExp(`^${name}=`, 'm').test(kept),
  );
  if (missing.length > 0) {
    const lines = missing.map((name) => `${name}=${values[name]}\n`).join('');
    appendFileSync(
      envFile,
      `${kept.endsWith('\n') ? '' : '\n'}\n# Added by setup-local (see .env.example):\n${lines}`,
    );
    console.log(`Settings: kept .env.local, added ${missing.join(', ')}`);
  } else {
    console.log('Settings: kept .env.local');
  }
} else {
  // Start from .env.example, so every setting keeps its explanation.
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  const body = example.replace(/^([A-Z0-9_]+)=.*$/gm, (line, name: string) =>
    name in values ? `${name}=${values[name]}` : line,
  );
  writeFileSync(
    envFile,
    `# Local testing settings, created by \`pnpm nx run api:setup-local\`.\n# Not committed (.env.* is git-ignored). Point CCMS_CONTENT_DIR at a real\n# content repository to test with real content.\n\n${body}`,
    { mode: 0o600 },
  );
  console.log('Settings: created .env.local');
}

const settings = readFileSync(envFile, 'utf8');
const setting = (name: string) =>
  new RegExp(`^${name}=(.*)$`, 'm').exec(settings)?.[1]?.trim() || undefined;
const token = setting('CCMS_API_TOKEN');
const authMode = setting('CCMS_AUTH_MODE') ?? 'token';
const database = await ensureDatabase(setting('CCMS_DATABASE_URL'));
const editorUrl =
  setting('CCMS_PUBLIC_URL') ??
  setting('CCMS_EDITOR_URL') ??
  'http://localhost:4200/';
const users =
  authMode === 'demo'
    ? await seedExampleUsers(setting('CCMS_DATABASE_URL'), database.ready)
    : await makeFirstAdmin(
        setting('CCMS_DATABASE_URL'),
        database.ready,
        editorUrl,
      );
const blobs =
  setting('CCMS_BLOB_DRIVER') === 's3'
    ? await ensureBucket(
        {
          endpoint: setting('CCMS_S3_ENDPOINT') ?? '',
          region: setting('CCMS_S3_REGION') ?? LOCAL_S3.region,
          accessKeyId: setting('CCMS_S3_ACCESS_KEY_ID') ?? '',
          secretAccessKey: setting('CCMS_S3_SECRET_ACCESS_KEY') ?? '',
        },
        setting('CCMS_S3_BUCKET') ?? localBucket(root),
      )
    : `${setting('CCMS_BLOB_DRIVER') ?? 'not set'} (CCMS_BLOB_DRIVER)`;
const base = `http://${setting('HOST') ?? '127.0.0.1'}:${setting('PORT') ?? '3100'}`;
console.log(`
Start the API:   pnpm nx run api:serve-local
API reference:   ${base}/docs  (click "Authorize" and paste the token)
Try it:          curl -H "Authorization: Bearer ${token}" ${base}/manuals
PDF:             ${base}/manuals/operating/variants/model=large/en/pdf
Token:           ${token}
Sign-in:         ${authMode === 'demo' ? 'demo mode: the editor lists the seeded users' : `with a password at ${editorUrl}sign-in (CCMS_AUTH_MODE=demo lists example users instead)`}
Users:           ${users}
Database:        ${database.text}
Blob store:      ${blobs}
Images:          pnpm nx run api:blobs-import  (moves the sample's assets/ into the store)`);

/**
 * Creates the database of a local (127.0.0.1, localhost) URL when Postgres
 * answers and the database is missing; says what to do when it does not
 * answer (`ready`: local, and there now). Never prints the URL itself: it
 * holds the password.
 */
async function ensureDatabase(
  url: string | undefined,
): Promise<{ text: string; ready: boolean }> {
  const not = (text: string) => ({ text, ready: false });
  if (!url || !URL.canParse(url)) return not('CCMS_DATABASE_URL is not set');
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const where = `${name} on ${target.host}`;
  if (!isLocal(target)) return not(`${where} (not local: left as it is)`);
  // The server's maintenance database, to look for (and create) this one.
  target.pathname = '/postgres';
  const client = new pg.Client({
    connectionString: target.toString(),
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    return not(`${where} not reachable (${reason(error)}).
                 Start Postgres with \`docker compose up -d\`, then run setup-local again.`);
  }
  try {
    const found = await client.query(
      'select 1 from pg_database where datname = $1',
      [name],
    );
    if (!found.rowCount) {
      await client.query(`create database ${pg.escapeIdentifier(name)}`);
    }
    // The slot's database says which checkout made it; one made before that, or whose comment
    // failed, gets it now. A comment of the person's own is kept.
    if (ownerComment && name === databaseName) {
      const comment = await client.query<{ comment: string | null }>(
        `select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1`,
        [name],
      );
      if (comment.rows[0]?.comment == null) {
        await client.query(
          `comment on database ${pg.escapeIdentifier(name)} is ${pg.escapeLiteral(ownerComment)}`,
        );
      }
    }
    return {
      text: found.rowCount ? where : `${where} (created)`,
      ready: true,
    };
  } catch (error) {
    return not(`${where} could not be checked or created (${reason(error)})`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function isLocal(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/**
 * Demo mode's users: the example roles and users (`db-seed --example`, which
 * migrates first), only into a local database that answered and holds no
 * users yet, so a seed of the person's own is never added to. Says what it
 * did, or the command to run when it could not.
 */
async function seedExampleUsers(
  url: string | undefined,
  ready: boolean,
): Promise<string> {
  const command = 'pnpm nx run api:db-seed -- --example';
  if (!url || !ready || !isLocal(new URL(url))) {
    return `not seeded (no local database answered); later: ${command}`;
  }
  const count = await countUsers(url);
  if (count === undefined) {
    return `not seeded (the users could not be counted); later: ${command}`;
  }
  if (count > 0) return `kept the ${count} already in the database`;
  const seed = join(apiDir, 'dist', 'database', 'seed.main.js');
  if (!existsSync(seed)) {
    return `not seeded (the API is not built); later: ${command}`;
  }
  const run = spawnSync(
    process.execPath,
    [`--env-file=${envFile}`, seed, '--example'],
    {
      cwd: apiDir,
      encoding: 'utf8',
      timeout: 120_000,
      // The database just checked (local, no users), never one the environment names instead:
      // `--env-file` does not override a variable that is already set.
      env: { ...process.env, CCMS_DATABASE_URL: url },
    },
  );
  if (run.status !== 0) {
    const why = (run.stderr || run.error?.message || '').trim().split('\n')[0];
    return `not seeded (${why || `exit ${run.status}`}); try: ${command}`;
  }
  return 'seeded the example roles and users (db-seed --example)';
}

/**
 * The first admin (#610): `admin@example.com` with the role `admin` (`api:first-admin`, which
 * migrates first), only into a local database that answered and holds no users yet. Answers
 * what it did, with the one-time link to choose their password, or the command to run.
 */
async function makeFirstAdmin(
  url: string | undefined,
  ready: boolean,
  editor: string,
): Promise<string> {
  const command = 'pnpm nx run api:first-admin -- <your email>';
  if (!url || !ready || !isLocal(new URL(url))) {
    return `no first admin (no local database answered); later: ${command}`;
  }
  const count = await countUsers(url);
  if (count === undefined) {
    return `no first admin (the users could not be counted); later: ${command}`;
  }
  if (count > 0) {
    return `kept the ${count} already in the database; a new link: ${command}`;
  }
  const script = join(apiDir, 'dist', 'database', 'first-admin.main.js');
  if (!existsSync(script)) {
    return `no first admin (the API is not built); later: ${command}`;
  }
  const run = spawnSync(
    process.execPath,
    [
      `--env-file=${envFile}`,
      script,
      'admin@example.com',
      '--name',
      'Admin',
      '--editor',
      editor,
    ],
    {
      cwd: apiDir,
      encoding: 'utf8',
      timeout: 120_000,
      // The database just checked (local, no users), as for the example users.
      env: { ...process.env, CCMS_DATABASE_URL: url },
    },
  );
  const link = run.stdout.trim().split('\n').pop();
  if (run.status !== 0 || !link) {
    const why = (run.stderr || run.error?.message || '').trim().split('\n')[0];
    return `no first admin (${why || `exit ${run.status}`}); try: ${command}`;
  }
  return `made the first admin admin@example.com; choose their password (once, within the invite's days):\n                 ${link}`;
}

/** The users in the database; 0 before the first migration made the table. */
async function countUsers(url: string): Promise<number | undefined> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    const result = await client.query<{ n: number }>(
      'select count(*)::int as n from users',
    );
    return result.rows[0]?.n ?? 0;
  } catch (error) {
    // 42P01: no `users` table yet (never migrated).
    return (error as { code?: string }).code === '42P01' ? 0 : undefined;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function reason(error: unknown): string {
  return error instanceof Error
    ? error.message || (error as { code?: string }).code || error.name
    : String(error);
}
