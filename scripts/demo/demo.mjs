// The demo set-up for the landing page films (#441, `docs/demo-videos.md`): one command starts
// the API and the editor on the demo content with the demo people, in a clean state; one resets
// it between takes.
//
//   pnpm demo:start [--lang en|de] [--user author|reviewer|admin] [--theme light|dark]
//                   [--api-port 3290] [--editor-port 4390] [--no-build]
//   pnpm demo:reset [the same options; left out: those of the running demo]
//   pnpm demo:stop
//   pnpm demo:status
//
// It runs in the background (`run.mjs`), on its own ports and its own folder (`.demo/`), with an
// in-memory database: nothing of the person's (`.local/`, their database, ports 3100, 4310 and
// 4320) is read or touched. Starting builds what it runs first (cached by Nx: quick when
// nothing changed).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PRODUCT_NAME } from './brand.mjs';
import {
  DEFAULT_PORTS,
  DEMO_DIR,
  LOG_FILE,
  ROOT,
  STATE_FILE,
} from './paths.mjs';
import { DEMO_PEOPLE } from './people.mjs';

const LANGS = ['en', 'de'];
const THEMES = ['light', 'dark'];
/** The person's own servers: the demo never takes them. */
const RESERVED = new Set([3100, 4310, 4320]);
/** How long starting may take: the stack, the content and the release files. */
const START_TIMEOUT_MS = 8 * 60_000;

const usage = `Usage: node scripts/demo/demo.mjs start|reset|stop|status [options]
  --lang en|de                 the interface language and the texts the demo writes (default en)
  --user author|reviewer|admin who the editor opens as (default author)
  --theme light|dark           the editor's theme (default light)
  --api-port <n>               the API's port (default ${DEFAULT_PORTS.api})
  --editor-port <n>            the editor's port (default ${DEFAULT_PORTS.editor})
  --no-build                   use the last builds of the API and the editor`;

/** The command line, checked: a command and its options (only those given). */
export function parseCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      user: { type: 'string' },
      theme: { type: 'string' },
      'api-port': { type: 'string' },
      'editor-port': { type: 'string' },
      'no-build': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help) return { command: 'help' };
  if (!['start', 'reset', 'stop', 'status'].includes(command) || rest.length) {
    throw new Error(usage);
  }
  const options = {};
  if (values.lang !== undefined) {
    if (!LANGS.includes(values.lang))
      throw new Error(`--lang: one of ${LANGS}`);
    options.lang = values.lang;
  }
  if (values.user !== undefined) {
    if (!Object.hasOwn(DEMO_PEOPLE, values.user)) {
      throw new Error(`--user: one of ${Object.keys(DEMO_PEOPLE)}`);
    }
    options.user = values.user;
  }
  if (values.theme !== undefined) {
    if (!THEMES.includes(values.theme)) {
      throw new Error(`--theme: one of ${THEMES}`);
    }
    options.theme = values.theme;
  }
  for (const [flag, key] of [
    ['api-port', 'apiPort'],
    ['editor-port', 'editorPort'],
  ]) {
    if (values[flag] === undefined) continue;
    const port = Number(values[flag]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`--${flag}: a port from 1024 to 65535`);
    }
    if (RESERVED.has(port)) {
      throw new Error(`--${flag}: ${port} is the person's own; choose another`);
    }
    options[key] = port;
  }
  if (options.apiPort !== undefined && options.apiPort === options.editorPort) {
    throw new Error('--api-port and --editor-port must differ');
  }
  return { command, options, build: !values['no-build'] };
}

/** The options a start uses: those given, else the running demo's, else the defaults. */
export function startOptions(given, previous = {}) {
  return {
    lang: 'en',
    user: 'author',
    theme: 'light',
    apiPort: DEFAULT_PORTS.api,
    editorPort: DEFAULT_PORTS.editor,
    ...previous,
    ...given,
  };
}

/** The address that opens the editor as `user`, in `lang` and `theme` (`editor-server.mjs`). */
export function startUrl(editorUrl, { lang, user, theme }) {
  const query = new URLSearchParams({
    lang,
    user: DEMO_PEOPLE[user].id,
    theme,
  });
  return `${editorUrl}/__start?${query}`;
}

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return undefined;
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const listening = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What `ps` says about a process: its command line and its process group, or nothing. */
const processInfo = (pid) => {
  const found = spawnSync('ps', ['-o', 'pgid=,command=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  if (found.error || !found.stdout) return undefined;
  const match = /^\s*(\d+)\s+(.*)$/.exec(found.stdout.trim());
  return match ? { pgid: Number(match[1]), command: match[2] } : undefined;
};

/** The demo's own background process: a recorded pid that is still `run.mjs`, never a reused one. */
export const isDemoProcess = (info) =>
  Boolean(info && /scripts[\\/]demo[\\/]run\.mjs(\s|$)/.test(info.command));

/** The processes listening on `port`. */
const pidsOn = (port) => {
  const found = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (found.error || !found.stdout) return [];
  return found.stdout
    .split('\n')
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

const PID_FILE = join(DEMO_DIR, 'run.pid');

/** The pid `start` recorded for the demo's process (written before it is ready), if any. */
const recordedPid = () => {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
};

/**
 * Stops the running demo. Only the demo's own processes are signalled: the recorded pid when it
 * is still `run.mjs`, then whatever is left of its process group (it is started detached, so
 * the group is its own, and the stack's database, API and editor are in it). Something else on the demo's ports, or a pid reused since,
 * is never touched.
 */
async function stop() {
  const state = readState();
  const pid = state?.pid ?? recordedPid();
  const ports = [
    state?.options?.apiPort ?? DEFAULT_PORTS.api,
    state?.options?.editorPort ?? DEFAULT_PORTS.editor,
  ];
  const running = Number.isInteger(pid) && isDemoProcess(processInfo(pid));
  if (running) {
    // The demo's process stops its stack itself; the group catches what it could not.
    signal(pid, 'SIGTERM');
    for (let i = 0; i < 100 && alive(pid); i += 1) await sleep(200);
    signal(-pid, 'SIGTERM');
  }
  // What still listens on the demo's ports in the demo's process group: the stack's processes,
  // left behind by a demo process that was killed outright. Anything else there is left alone.
  let leftovers = false;
  if (Number.isInteger(pid)) {
    for (const port of ports) {
      for (const listener of pidsOn(port)) {
        if (processInfo(listener)?.pgid !== pid) continue;
        signal(listener, 'SIGTERM');
        leftovers = true;
      }
    }
  }
  if (running || leftovers) {
    for (const port of ports) {
      for (let i = 0; i < 50 && (await listening(port)); i += 1) {
        await sleep(200);
      }
    }
  }
  rmSync(STATE_FILE, { force: true });
  rmSync(PID_FILE, { force: true });
  return running || leftovers;
}

function build() {
  console.log(
    'Building the API and the editor (cached when nothing changed) …',
  );
  execFileSync(
    'pnpm',
    [
      'nx',
      'run-many',
      '-t',
      'build',
      '-p',
      'api',
      'editor',
      '--output-style=static',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

async function start(options, { build: shouldBuild }) {
  const running = readState();
  if (running && isDemoProcess(processInfo(running.pid))) {
    console.log(
      `The demo is running already: ${startUrl(running.editorUrl, running.options)}\nUse pnpm demo:reset for a fresh one.`,
    );
    return;
  }
  const starting = recordedPid();
  if (starting !== undefined && isDemoProcess(processInfo(starting))) {
    throw new Error(
      'A demo is starting already: wait for it, or stop it with pnpm demo:stop.',
    );
  }
  for (const port of [options.apiPort, options.editorPort]) {
    if (await listening(port)) {
      throw new Error(
        `Port ${port} is in use. Stop what listens there, or choose another with --api-port / --editor-port.`,
      );
    }
  }
  if (shouldBuild) build();
  mkdirSync(DEMO_DIR, { recursive: true, mode: 0o700 });
  chmodSync(DEMO_DIR, 0o700);
  rmSync(STATE_FILE, { force: true });
  const logFd = openSync(LOG_FILE, 'w');
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, 'run.mjs')],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, DEMO_OPTIONS: JSON.stringify(options) },
    },
  );
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`Starting the ${PRODUCT_NAME} demo (log: ${LOG_FILE}) …`);
  const end = Date.now() + START_TIMEOUT_MS;
  let shown = 0;
  while (Date.now() < end) {
    const lines = readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('[demo]'));
    for (const line of lines.slice(shown)) console.log(`  ${line.slice(7)}`);
    shown = lines.length;
    const state = readState();
    if (state) {
      console.log(`
Demo ready (${state.seconds} s).
Open:     ${startUrl(state.editorUrl, options)}
Editor:   ${state.editorUrl}   API: ${state.apiUrl}
People:   ${Object.values(DEMO_PEOPLE)
        .map((p) => p.name)
        .join(', ')}
Reset:    pnpm demo:reset     Stop: pnpm demo:stop`);
      return;
    }
    if (!alive(child.pid)) {
      rmSync(PID_FILE, { force: true });
      throw new Error(`The demo did not start; see ${LOG_FILE}`);
    }
    await sleep(500);
  }
  await stop();
  throw new Error(`The demo did not get ready in time; see ${LOG_FILE}`);
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed.command === 'help') {
    console.log(usage);
    return;
  }
  const { command, options } = parsed;
  if (command === 'status') {
    const state = readState();
    console.log(
      state && alive(state.pid) && isDemoProcess(processInfo(state.pid))
        ? `Running: ${startUrl(state.editorUrl, state.options)}`
        : 'Not running.',
    );
    return;
  }
  if (command === 'stop') {
    console.log((await stop()) ? 'Stopped.' : 'Not running.');
    return;
  }
  const previous = readState()?.options;
  if (command === 'reset') await stop();
  await start(
    startOptions(options, command === 'reset' ? previous : {}),
    parsed,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
