// Starts what the suite runs against, fresh for every run and shared by nobody else:
//
// 1. a database (`db.mjs`: in-memory PGlite on a free port), migrated and seeded with the
//    example roles and users (`api:db-migrate`, `api:db-seed -- --example`);
// 2. a copy of the sample content repository (as `api:setup-local` makes it) and a blob folder,
//    in a folder of this run under `.local/editor-e2e/`;
// 3. the built API (`backend/api/dist/main.js`) in demo mode, on a free port;
// 4. the built editor (`editor-server.mjs`) on another free port, proxying `/api` to it;
// 5. for the sign-in flows (#37): a local OpenID Connect provider (`backend/api/scripts/mock-oidc.ts`),
//    a second API on the same database with sign-in on (`CCMS_ROLE=api`: no background work of
//    its own), and a second editor in front of it whose proxy adds no token, as a deployment
//    with sign-in has it;
// 6. for the public sandbox flows (#826), when asked for (`sandbox: true`): a third API in a
//    public sandbox (`CCMS_PUBLIC_SANDBOX=on`, demo mode), with a database, content and blob
//    folder of its own, as a sandbox runs every role in one process (its background jobs must
//    never take the other APIs'), and a third editor in front of it, with the token.
//
// Ports come from the operating system, so a run in an agent slot and one in the main checkout
// never meet, and the person's own servers (3100, 4310, 4320) are never used. The demo set-up
// (`scripts/demo/`, #441) starts the same stack with options of its own: its content, users and
// fixed ports, without the sign-in pair. The API gets a clean
// environment: nothing from the shell or `.env.local` reaches it.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = join(import.meta.dirname, '..', '..', '..');
/** This checkout's folder for the suite: runs, results, report (`.local/` is git-ignored). */
export const E2E_DIR = join(ROOT, '.local', 'editor-e2e');
/** The sandbox API's idle and longest session (6. below), in minutes: longer than any run. */
export const SANDBOX_MINUTES = 1440;
const API_DIST = join(ROOT, 'backend/api/dist');
const MOCK_OIDC = join(ROOT, 'backend/api/scripts/mock-oidc.ts');
const EDITOR_DIST = join(ROOT, 'frontend/editor/dist/browser');
/** The person's own servers (the API, the editor, the docs site): never ours. */
const RESERVED_PORTS = new Set([3100, 4310, 4320]);

/**
 * A port nothing listens on: `fixed` when given (the demo's own, `scripts/demo/`), refused if it
 * is one of the person's; else one from the operating system.
 */
async function freePort(fixed?: number): Promise<number> {
  if (fixed !== undefined) {
    if (RESERVED_PORTS.has(fixed)) {
      throw new Error(`port ${fixed} is the person's own: choose another`);
    }
    return fixed;
  }
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

type Env = Record<string, string>;

/**
 * The people the local provider signs in (`specs/sign-in.spec.ts`), by login name. Groups map to
 * roles through the group mappings a flow makes.
 */
export const OIDC_ACCOUNTS = {
  'e2e-writer': {
    name: 'E2E Writer',
    email: 'e2e-writer@example.org',
    groups: ['e2e-writers'],
  },
  'e2e-outsider': { name: 'E2E Outsider', groups: [] },
  // Made by an admin before their first sign-in: linked by the verified address.
  'e2e-lead': { name: 'E2E Lead', email: 'e2e-lead@example.org', groups: [] },
  // The admin of the password flows (#610), linked to an admin made for them.
  'e2e-pw-admin': {
    name: 'E2E Password Admin',
    email: 'e2e-pw-admin@example.org',
    groups: [],
  },
} as const;

/** Runs a node script to its end with `env`; rejects with its output when it fails. */
function runNode(script: string, args: string[], env: Env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => (output += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${script} failed (${code}):\n${output}`)),
    );
  });
}

/**
 * Starts a long-running node script and waits until it prints `ready <port>`.
 * Its output goes to `log`.
 */
function startNode(
  script: string,
  env: Env,
  log: (text: string) => void,
  timeoutMs = 60_000,
): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} did not start in time:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk;
      log(String(chunk));
      const ready = /^ready (\d+)$/m.exec(output);
      if (ready) {
        clearTimeout(timer);
        resolve({ child, port: Number(ready[1]) });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`${script} ended (${code}) before it was ready:\n${output}`),
      );
    });
  });
}

/** Waits until `url` answers 200. */
async function waitFor(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  let exited = false;
  child.once('exit', () => (exited = true));
  while (Date.now() < end) {
    if (exited) throw new Error(`the process serving ${url} ended`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000} s`);
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export interface Stack {
  /** The API itself, for the tests' helpers (`src/api.ts`). */
  readonly apiUrl: string;
  /** The editor, its `/api` proxied to the API. */
  readonly editorUrl: string;
  /** The API's shared token (demo mode): random, for this run only. */
  readonly token: string;
  /**
   * The editor in front of the API with sign-in on (#37): no token, a session cookie. Empty
   * when the stack was started without it (`signIn: false`).
   */
  readonly signInEditorUrl: string;
  /**
   * The editor in front of an API in a public sandbox (#826): demo mode, uploads, imports and
   * outbound refused. Empty when the stack was started without it (`sandbox: false`).
   */
  readonly sandboxEditorUrl: string;
  /**
   * The database, for the few states no route makes (`src/database.ts`): a refused planning of
   * a release's files (#477).
   */
  readonly databaseUrl: string;
  /** This run's folder (content, blobs), removed by `stop()` unless E2E_KEEP_STACK is set. */
  readonly runDir: string;
  stop(): Promise<void>;
}

export interface StackOptions {
  /**
   * The folder for its runs and its log, `E2E_DIR` by default: another tool on the same stack
   * (the user guide's screenshots, `screenshots/`) keeps its own, so it never touches the suite's.
   */
  readonly dir?: string;
  /**
   * More sample content on top of the suite's (the user guide's screenshots add the page designs
   * and the safety leaflet, as `api:setup-local` does): called with the bare repository and the
   * content repository's `testing` module before the API starts.
   */
  readonly content?: (
    contentDir: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    testing: Record<string, any>,
  ) => Promise<void>;
  /**
   * Content of its own in place of the sample (the demo's, `scripts/demo/`): makes the bare
   * repository at `contentDir`. `content` is not called then.
   */
  readonly repository?: (contentDir: string) => Promise<void> | void;
  /** A seed file (`db-seed <file.json>`) in place of the example roles and users. */
  readonly seedFile?: string;
  /** The API's and the editor's ports (the demo's own); left out, the system picks them. */
  readonly ports?: { readonly api?: number; readonly editor?: number };
  /**
   * The second API and editor with sign-in on, and the provider they sign in with (5. above);
   * default on. The demo, which signs in in demo mode only, leaves them out.
   */
  readonly signIn?: boolean;
  /**
   * The third API and editor, in a public sandbox (6. above); default off: the suite turns them
   * on, the demo and the guide's screenshots do without.
   */
  readonly sandbox?: boolean;
  /**
   * The editor's `/__start` page (`editor-server.mjs`), which stores the interface language,
   * the demo user and the theme, then opens the editor: the demo's. Default off.
   */
  readonly startPage?: boolean;
}

/** Starts the stack. Resolves with its addresses, the token and `stop()`. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const dir = options.dir ?? E2E_DIR;
  for (const [what, file] of [
    ['the API (pnpm nx build api)', join(API_DIST, 'main.js')],
    ['the editor (pnpm nx build editor)', join(EDITOR_DIST, 'index.html')],
  ] as const) {
    if (!existsSync(file))
      throw new Error(`Build ${what} first: ${file} is missing`);
  }
  const runDir = join(dir, `run-${process.pid}-${Date.now()}`);
  const contentDir = join(runDir, 'content.git');
  const blobDir = join(runDir, 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const logFile = join(dir, 'stack.log');
  const logs: string[] = [];
  const log = (name: string) => (text: string) => {
    logs.push(`[${name}] ${text}`);
  };
  const children: ChildProcess[] = [];

  const stop = async () => {
    for (const child of children.reverse()) await stopChild(child);
    writeFileSync(logFile, logs.join(''));
    if (!process.env.E2E_KEEP_STACK) {
      rmSync(runDir, { recursive: true, force: true });
    }
  };

  try {
    const base: Env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      NODE_ENV: 'production',
    };

    // 1. The database: migrated and seeded.
    const startDatabase = async (name: string) => {
      const db = await startNode(
        join(import.meta.dirname, 'db.mjs'),
        base,
        log(name),
      );
      children.push(db.child);
      const url = `postgres://postgres@127.0.0.1:${db.port}/postgres`;
      const env = { ...base, CCMS_DATABASE_URL: url };
      await runNode(join(API_DIST, 'database/migrate.main.js'), [], env);
      await runNode(
        join(API_DIST, 'database/seed.main.js'),
        [options.seedFile ?? '--example'],
        env,
      );
      return url;
    };
    const databaseUrl = await startDatabase('db');
    const dbEnv = { ...base, CCMS_DATABASE_URL: databaseUrl };

    // 2. The content, as setup-local makes it.
    const makeContent = async (dir: string) => {
      if (options.repository) {
        await options.repository(dir);
        return;
      }
      const testing = await import(
        pathToFileURL(join(ROOT, 'packages/content-repo/dist/testing.js')).href
      );
      testing.createBareSampleRepo(dir);
      await testing.addSampleSnippets(dir);
      await testing.addSampleTerms(dir);
      await testing.addSampleRtlLanguages(dir);
      // The example template and a broken one (#396): read only, so no flow changes them.
      const typst = await import(
        pathToFileURL(join(ROOT, 'packages/render-typst/dist/index.js')).href
      );
      testing.addSampleTemplates(dir, typst.SAMPLE_TEMPLATES);
      await options.content?.(dir, testing);
    };
    await makeContent(contentDir);

    // 3. The APIs: the demo one, and the one with sign-in on (5.), started side by side.
    const token = randomBytes(32).toString('hex');
    const apiPort = await freePort(options.ports?.api);
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const signIn = options.signIn ?? true;
    const signInEditorPort = signIn ? await freePort() : 0;
    const signInEditorUrl = signIn
      ? `http://127.0.0.1:${signInEditorPort}`
      : '';
    const apiEnv: Env = {
      ...dbEnv,
      HOST: '127.0.0.1',
      CCMS_CONTENT_DIR: contentDir,
      CCMS_API_TOKEN: token,
      CCMS_DEFAULT_REF: 'main',
      CCMS_DATABASE_MIGRATE: 'false',
      CCMS_BLOB_DRIVER: 'fs',
      CCMS_BLOB_FS_ROOT: blobDir,
      // Where readers reach the stable addresses (#450): their URLs and QR codes; never opened.
      CCMS_PUBLIC_URL: 'https://docs.example.com/',
      // Every test signs in through the same address: no lock-out.
      CCMS_AUTH_FAILURES_MAX: '0',
    };
    const startApi = (name: string, url: string, env: Env) => {
      const child = spawn(process.execPath, [join(API_DIST, 'main.js')], {
        env: { ...apiEnv, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      child.stdout.on('data', (chunk: Buffer) => log(name)(String(chunk)));
      child.stderr.on('data', (chunk: Buffer) => log(name)(String(chunk)));
      return waitFor(`${url}/health/ready`, child, 120_000).catch((error) => {
        throw new Error(
          `${(error as Error).message}\n${logs.filter((l) => l.startsWith(`[${name}]`)).join('')}`,
          { cause: error },
        );
      });
    };
    const apis = [
      startApi('api', apiUrl, {
        PORT: String(apiPort),
        CCMS_AUTH_MODE: 'demo',
        CCMS_PDF_WORKERS: '2',
      }),
    ];
    // 6. The public sandbox (#826): every role in one process (its caps and clock are one
    // process's), so a database, content and blobs of its own: its jobs never take the others'.
    const sandbox = options.sandbox ?? false;
    const sandboxApiPort = sandbox ? await freePort() : 0;
    const sandboxApiUrl = sandbox ? `http://127.0.0.1:${sandboxApiPort}` : '';
    if (sandbox) {
      const sandboxDir = join(runDir, 'sandbox');
      const sandboxBlobs = join(sandboxDir, 'blobs');
      mkdirSync(sandboxBlobs, { recursive: true });
      const sandboxContent = join(sandboxDir, 'content.git');
      const [sandboxDatabase] = await Promise.all([
        startDatabase('db-sandbox'),
        makeContent(sandboxContent),
      ]);
      const started = startApi('api-sandbox', sandboxApiUrl, {
        PORT: String(sandboxApiPort),
        CCMS_DATABASE_URL: sandboxDatabase,
        CCMS_CONTENT_DIR: sandboxContent,
        CCMS_BLOB_FS_ROOT: sandboxBlobs,
        CCMS_AUTH_MODE: 'demo',
        CCMS_PUBLIC_SANDBOX: 'on',
        // A day, so a long suite never sees the session end (`SANDBOX_MINUTES`).
        CCMS_SANDBOX_IDLE_MINUTES: String(SANDBOX_MINUTES),
        CCMS_SANDBOX_MAX_MINUTES: String(SANDBOX_MINUTES),
      });
      started.catch(() => undefined);
      apis.push(started);
    }
    // Awaited below with the sign-in API; until then a failure must not go unhandled (it would end
    // the process before `stop()` cleans up).
    apis[0]?.catch(() => undefined);
    let signInApiUrl = '';
    if (signIn) {
      const mock = await startNode(
        MOCK_OIDC,
        {
          ...base,
          MOCK_OIDC_CLIENT_ID: 'of-e2e',
          MOCK_OIDC_REDIRECT_URIS: `${signInEditorUrl}/api/auth/oidc/callback`,
          MOCK_OIDC_POST_LOGOUT_URIS: `${signInEditorUrl}/sign-in`,
          MOCK_OIDC_ACCOUNTS: JSON.stringify(OIDC_ACCOUNTS),
        },
        log('mock-oidc'),
      );
      children.push(mock.child);
      const signInApiPort = await freePort();
      signInApiUrl = `http://127.0.0.1:${signInApiPort}`;
      apis.push(
        startApi('api-sign-in', signInApiUrl, {
          PORT: String(signInApiPort),
          CCMS_ROLE: 'api',
          CCMS_OIDC_ISSUER: `http://127.0.0.1:${mock.port}`,
          CCMS_OIDC_CLIENT_ID: 'of-e2e',
          CCMS_OIDC_REDIRECT_URL: `${signInEditorUrl}/api/auth/oidc/callback`,
          CCMS_OIDC_NAME: 'Mock provider',
        }),
      );
    }
    await Promise.all(apis);

    // 4. The editors: the demo one with the token, the one with sign-in without.
    const editorEnv = { ...base, E2E_EDITOR_DIST: EDITOR_DIST };
    const startEditor = async (name: string, port: number, env: Env) => {
      const editor = await startNode(
        join(import.meta.dirname, 'editor-server.mjs'),
        { ...editorEnv, E2E_EDITOR_PORT: String(port), ...env },
        log(name),
      );
      children.push(editor.child);
      return editor;
    };
    const [editor] = await Promise.all([
      startEditor('editor', await freePort(options.ports?.editor), {
        E2E_API_URL: apiUrl,
        E2E_API_TOKEN: token,
        ...(options.startPage && { E2E_EDITOR_START_PAGE: '1' }),
      }),
      ...(signIn
        ? [
            startEditor('editor-sign-in', signInEditorPort, {
              E2E_API_URL: signInApiUrl,
            }),
          ]
        : []),
    ]);
    const editorUrl = `http://127.0.0.1:${editor.port}`;
    const sandboxEditor = sandbox
      ? await startEditor('editor-sandbox', await freePort(), {
          E2E_API_URL: sandboxApiUrl,
          E2E_API_TOKEN: token,
        })
      : null;
    const sandboxEditorUrl = sandboxEditor
      ? `http://127.0.0.1:${sandboxEditor.port}`
      : '';

    return {
      apiUrl,
      editorUrl,
      token,
      signInEditorUrl,
      sandboxEditorUrl,
      databaseUrl,
      runDir,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
