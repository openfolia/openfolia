// The demo's finished state, made once for the sandbox image (#827; Dockerfile, target
// `sandbox`): the demo content, the demo people, the two releases with their PDFs and the change
// set in review (`populate.mjs`), in one language's texts, written to a folder the image keeps
// read only and every sandbox starts from a copy of:
//
//   node scripts/demo/bake.mjs --lang en|de --out <folder>
//
//   <folder>/pgdata        the database (PGlite's data folder, `backend/sandbox`)
//   <folder>/content.git   the content repository (bare)
//   <folder>/blobs         the blob store (`fs`): the release PDFs
//   <folder>/baked.json    what was made: the language, the releases, the change sets
//
// It needs the builds of the API and of `backend/sandbox` (`pnpm nx run-many -t build -p api
// sandbox`) and git; it runs the API in demo mode on loopback ports the system picks, and nothing
// else. No instance secret key is made (`CCMS_SECRET_KEY_GENERATE=false`), so the database holds
// no key check and no sealed value: every sandbox makes a key of its own at its first start.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildDemoRepo } from './content.mjs';
import { ROOT } from './paths.mjs';
import { DEMO_PEOPLE, demoSeed } from './people.mjs';
import { Client, populate } from './populate.mjs';

const API_DIST = join(ROOT, 'backend/api/dist');
const DB_SERVER = join(ROOT, 'backend/sandbox/dist/db-server.js');
const LANGS = ['en', 'de'];

const log = (text) => console.log(`[bake] ${text}`);

/** `--lang` and `--out`, checked: the folder must not hold anything yet. */
export function bakeArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { lang: { type: 'string' }, out: { type: 'string' } },
  });
  if (!LANGS.includes(values.lang ?? ''))
    throw new Error(`bake: --lang must be one of ${LANGS.join(', ')}`);
  if (!values.out) throw new Error('bake: --out names the folder to write');
  const out = resolve(values.out);
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Error(`bake: ${out} is not empty`);
  return { lang: values.lang, out };
}

const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

/** A child process whose output is kept for the error message; `ready` waits for a line. */
function start(script, args, env, readyLine) {
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ended = new Promise((done) => child.once('exit', done));
  const ready = new Promise((done, fail) => {
    const onData = (chunk) => {
      output += chunk;
      const match = readyLine && readyLine.exec(output);
      if (match) done(match);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) =>
      fail(new Error(`${script} ended (${code}):\n${output.slice(-4000)}`)),
    );
  });
  ready.catch(() => undefined);
  const stop = async () => {
    if (child.exitCode !== null) return child.exitCode;
    child.kill('SIGTERM');
    return ended;
  };
  return { child, ready, ended, stop, output: () => output };
}

const run = (script, args, env) =>
  execFileSync(process.execPath, [script, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

async function waitForReady(url, api, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (api.child.exitCode !== null)
      throw new Error(`the API ended:\n${api.output().slice(-4000)}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`the API did not get ready:\n${api.output().slice(-4000)}`);
}

/** Waits until no background job waits or runs (`GET /jobs/status`), so nothing is half done. */
async function waitForJobs(admin, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await admin.get('/jobs/status');
    const { ready, running } = data.attributes;
    if (ready === 0 && running === 0) return;
    if (Date.now() > end)
      throw new Error(`background jobs still busy: ${JSON.stringify(data)}`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

export async function bake({ lang, out }) {
  const started = Date.now();
  for (const [what, file] of [
    ['the API (pnpm nx build api)', join(API_DIST, 'main.js')],
    ['the sandbox (pnpm nx build sandbox)', DB_SERVER],
  ])
    if (!existsSync(file))
      throw new Error(`bake: build ${what} first: ${file} is missing`);
  const pgdata = join(out, 'pgdata');
  const contentDir = join(out, 'content.git');
  const blobDir = join(out, 'blobs');
  mkdirSync(blobDir, { recursive: true });

  log(`the content (${lang})`);
  buildDemoRepo(contentDir);

  const base = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
  };
  const db = start(DB_SERVER, ['--data', pgdata], base, /^ready (\d+)$/m);
  let api;
  try {
    const [, dbPort] = await db.ready;
    const dbEnv = {
      ...base,
      CCMS_DATABASE_URL: `postgres://postgres@127.0.0.1:${dbPort}/postgres`,
    };
    log('the database: migrated and seeded with the demo people');
    run(join(API_DIST, 'database/migrate.main.js'), [], dbEnv);
    const { PERMISSIONS } = await import(
      pathToFileURL(join(API_DIST, 'access/core/permissions.js')).href
    );
    const seedFile = join(out, 'seed.json');
    writeFileSync(seedFile, JSON.stringify(demoSeed(PERMISSIONS)));
    run(join(API_DIST, 'database/seed.main.js'), [seedFile], dbEnv);
    rmSync(seedFile);

    const token = randomBytes(32).toString('hex');
    const port = await freePort();
    const apiUrl = `http://127.0.0.1:${port}`;
    api = start(join(API_DIST, 'main.js'), [], {
      ...dbEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      CCMS_AUTH_MODE: 'demo',
      CCMS_API_TOKEN: token,
      CCMS_CONTENT_DIR: contentDir,
      CCMS_DEFAULT_REF: 'main',
      CCMS_DATABASE_MIGRATE: 'false',
      CCMS_BLOB_DRIVER: 'fs',
      CCMS_BLOB_FS_ROOT: blobDir,
      CCMS_SECRET_KEY_GENERATE: 'false',
      CCMS_PDF_WORKERS: '2',
    });
    await waitForReady(`${apiUrl}/health/ready`, api);

    log('the demo state, through the API');
    const made = await populate({ apiUrl, token, lang, log });
    for (const [revision, summary] of Object.entries(made.outputs)) {
      if (summary.state !== 'done')
        throw new Error(
          `bake: release ${revision}'s files are ${JSON.stringify(summary)}`,
        );
    }
    await waitForJobs(new Client(apiUrl, token, DEMO_PEOPLE.admin));

    log('stopping, the database written out');
    const apiCode = await api.stop();
    if (apiCode !== 0 && apiCode !== null)
      throw new Error(`bake: the API ended with ${apiCode}`);
    api = undefined;
    const dbCode = await db.stop();
    if (dbCode !== 0)
      throw new Error(`bake: the database ended with ${dbCode}`);

    // Every object in one pack, nothing loose: a smaller repository for each sandbox to copy at start.
    execFileSync('git', ['-C', contentDir, 'gc', '--quiet', '--prune=now']);
    writeFileSync(
      join(out, 'baked.json'),
      JSON.stringify(
        {
          lang,
          bakedAt: new Date().toISOString(),
          releases: made.releases,
          fix: made.fix,
          review: made.review,
          outputs: made.outputs,
        },
        null,
        2,
      ) + '\n',
    );
    log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    await api?.stop();
    await db.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  bake(bakeArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[bake] failed: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
