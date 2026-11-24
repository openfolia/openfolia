// The public demo's shared portal (#828; Dockerfile, target `demo-portal`): the reader portal of
// the demo's released manuals, built once from a normal instance of the API over a copy of the
// baked state (bake.mjs), never from a sandbox's API (a sandbox's demo sign-in is an admin). The
// API runs on loopback ports for the build only; the portal reads it with a token of a read-only
// role (content.read up to the audience), as deploy/self-host.sh sets it up.
//
//   node scripts/demo/portal.mjs --state <baked folder> --portal <portal app> --out <folder>
//                                [--audience owner] [--languages en,de]
//
// <portal app>: frontend/portal, or the portal image's /app/portal. It needs the API's build and
// `backend/sandbox`'s (as bake.mjs does); <folder> must not hold anything yet.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  API_DIST,
  DB_SERVER,
  freePort,
  run,
  start,
  waitForReady,
} from './bake.mjs';

const log = (text) => console.log(`[demo-portal] ${text}`);

export function portalArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      state: { type: 'string' },
      portal: { type: 'string' },
      out: { type: 'string' },
      audience: { type: 'string', default: 'owner' },
      languages: { type: 'string', default: 'en,de' },
    },
  });
  for (const name of ['state', 'portal', 'out'])
    if (!values[name]) throw new Error(`demo-portal: --${name} is required`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(values.audience))
    throw new Error('demo-portal: --audience is an audience ID');
  const out = resolve(values.out);
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new Error(`demo-portal: ${out} is not empty`);
  return {
    ...values,
    state: resolve(values.state),
    portal: resolve(values.portal),
    out,
  };
}

export async function buildDemoPortal({
  state,
  portal,
  out,
  audience,
  languages,
}) {
  // A copy: the baked state stays as it is (the image keeps it read only).
  const work = mkdtempSync(join(tmpdir(), 'openfolia-demo-portal-'));
  const base = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
  };
  let db;
  let api;
  try {
    cpSync(state, work, { recursive: true });
    // The image keeps the baked state read only (a=rX): the copy must be the database's to write.
    execFileSync('chmod', ['-R', 'u+w', work]);
    db = start(
      DB_SERVER,
      ['--data', join(work, 'pgdata')],
      base,
      /^ready (\d+)$/m,
    );
    const [, dbPort] = await db.ready;
    const dbEnv = {
      ...base,
      CCMS_DATABASE_URL: `postgres://postgres@127.0.0.1:${dbPort}/postgres`,
    };
    log(`a read-only role up to "${audience}" and its token`);
    const seed = join(work, 'seed.json');
    writeFileSync(
      seed,
      JSON.stringify({
        roles: [
          {
            id: 'portal-reader',
            name: 'Portal reader',
            permissions: ['content.read'],
            scope: { maxAudience: audience },
          },
        ],
        users: [],
      }),
    );
    run(join(API_DIST, 'database/seed.main.js'), [seed], dbEnv);
    const token = run(
      join(API_DIST, 'database/service-token.main.js'),
      ['portal', '--role', 'portal-reader', '--name', 'portal', '--days', '1'],
      dbEnv,
    )
      .trim()
      .split('\n')
      .at(-1);
    if (!token || !/^\S{20,}$/.test(token))
      throw new Error('demo-portal: no service token');

    // A normal instance: not a public sandbox; nobody but this build reaches it.
    const port = await freePort();
    const apiUrl = `http://127.0.0.1:${port}`;
    api = start(join(API_DIST, 'main.js'), [], {
      ...dbEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      CCMS_AUTH_MODE: 'demo',
      CCMS_API_TOKEN: randomBytes(32).toString('hex'),
      CCMS_CONTENT_DIR: join(work, 'content.git'),
      CCMS_DEFAULT_REF: 'main',
      CCMS_DATABASE_MIGRATE: 'false',
      CCMS_BLOB_DRIVER: 'fs',
      CCMS_BLOB_FS_ROOT: join(work, 'blobs'),
      CCMS_SECRET_KEY_GENERATE: 'false',
    });
    await waitForReady(`${apiUrl}/health/ready`, api);

    log(`the portal for "${audience}" in ${languages}`);
    execFileSync(process.execPath, ['scripts/build.ts'], {
      cwd: portal,
      stdio: 'inherit',
      env: {
        ...base,
        CCMS_PORTAL_API_URL: apiUrl,
        CCMS_PORTAL_TOKEN: token,
        CCMS_PORTAL_AUDIENCE: audience,
        CCMS_PORTAL_LANGUAGES: languages,
        CCMS_PORTAL_OUT_DIR: out,
        ASTRO_TELEMETRY_DISABLED: '1',
      },
    });
    log(`written to ${out}`);
  } finally {
    await api?.stop();
    await db?.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  buildDemoPortal(portalArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[demo-portal] failed: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
