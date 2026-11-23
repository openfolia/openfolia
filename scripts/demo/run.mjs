// The demo's long-running process (#441), started in the background by `demo.mjs start`: the
// editor's end-to-end stack (`frontend/editor-e2e/stack/stack.ts`: an in-memory database, the
// built API in demo mode, the built editor) on the demo content, the demo people and the demo's
// own ports, then the state the films need (`populate.mjs`). Writes `state.json` once it is
// ready; on SIGTERM it stops everything, and the database and the content are gone with it.
//
//   DEMO_OPTIONS='{"lang":"de","apiPort":3290,"editorPort":4390}' node scripts/demo/run.mjs

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDemoRepo } from './content.mjs';
import { DEMO_DIR, ROOT, STATE_FILE } from './paths.mjs';
import { demoSeed } from './people.mjs';
import { populate } from './populate.mjs';

const options = JSON.parse(process.env.DEMO_OPTIONS ?? '{}');
const log = (text) => console.log(`[demo] ${text}`);

// Loaded by path: the stack and the permissions are other projects' files (the stack's own
// TypeScript, which Node runs as it is; the API's build).
const { startStack } = await import(
  pathToFileURL(join(ROOT, 'frontend/editor-e2e/stack/stack.ts')).href
);
const { PERMISSIONS } = await import(
  pathToFileURL(join(ROOT, 'backend/api/dist/access/core/permissions.js')).href
);

mkdirSync(DEMO_DIR, { recursive: true, mode: 0o700 });
chmodSync(DEMO_DIR, 0o700);
const seedFile = join(DEMO_DIR, 'seed.json');
writeFileSync(seedFile, JSON.stringify(demoSeed(PERMISSIONS), null, 2));

let stack;
/** The stack while it starts: a stop then waits for it, so nothing it started is left behind. */
let starting;
let stopping = false;
const stop = async (code) => {
  if (stopping) return;
  stopping = true;
  rmSync(STATE_FILE, { force: true });
  rmSync(join(DEMO_DIR, 'run.pid'), { force: true });
  // A stack that fails to start stops what it started itself.
  stack ??= await starting?.catch(() => undefined);
  await stack?.stop();
  log('stopped');
  process.exit(code);
};
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));

try {
  const started = Date.now();
  log('starting the database, the API and the editor');
  starting = startStack({
    dir: DEMO_DIR,
    repository: (dir) => {
      buildDemoRepo(dir);
    },
    seedFile,
    ports: { api: options.apiPort, editor: options.editorPort },
    signIn: false,
    startPage: true,
  });
  stack = await starting;
  if (stopping) await new Promise(() => undefined); // the stop in progress ends the process
  log(`API ${stack.apiUrl}, editor ${stack.editorUrl}`);
  const made = await populate({
    apiUrl: stack.apiUrl,
    token: stack.token,
    lang: options.lang,
    log,
  });
  log(`release files: ${JSON.stringify(made.outputs)}`);
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        pid: process.pid,
        options,
        apiUrl: stack.apiUrl,
        editorUrl: stack.editorUrl,
        token: stack.token,
        made,
        seconds: Math.round((Date.now() - started) / 1000),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  log(`ready in ${Math.round((Date.now() - started) / 1000)} s`);
} catch (error) {
  console.error(`[demo] failed: ${error?.stack ?? error}`);
  await stop(1);
}
