import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  type ApiCredential,
  ApiError,
  apiBaseUrl,
  ImportApi,
  readSessionCookie,
} from './client.js';
import { TrackerMapping } from './mapping.js';
import { runOnce, type RunResult } from './run.js';
import { FixtureSource, type ItemSource } from './source.js';
import {
  abortableSleep,
  createTriggerListener,
  parseListen,
  RunQueue,
  TRIGGER_PATH,
  TRIGGER_SECRET_MIN_LENGTH,
} from './webhook.js';

/** The shortest time from one run's start to the next one's while listening for triggers. */
export const TRIGGER_MIN_GAP_MS = 60_000;

export const USAGE = `Usage: openfolia-tracker-connector --mapping <mapping.yaml> --items <items.json> [--every <minutes>] [--listen [<host>:]<port>]

Reads the items (a fixture file of the sample format), converts the ones the mapping
includes into an import bundle and imports it through the content API into a change set,
submitted for review. Nothing is published without that review. With --every, runs again
every so many minutes (1 to 1440) until stopped; otherwise once (for a scheduler such as
cron). With --listen, also runs when the source calls POST /trigger on that address
(127.0.0.1 unless a host is given), signed with CCMS_CONNECTOR_WEBHOOK_SECRET: it answers
at once and queues the run, one after the other, at most one a minute. The only outbound
calls are to CCMS_CONNECTOR_API_URL.

Settings (environment):
  CCMS_CONNECTOR_API_URL       the content API's base URL (https; http only to this machine)
  CCMS_CONNECTOR_SESSION_FILE  the cookie file of a signed-in person who may import
                               (admin.roles and content.edit), read again on every run
  CCMS_CONNECTOR_WEBHOOK_SECRET the secret the source signs its triggers with (--listen
                               only; at least ${TRIGGER_SECRET_MIN_LENGTH} characters)`;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CliDeps {
  readonly fetch?: typeof fetch;
  /** Between scheduled runs; resolves early when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Stops the schedule between runs. */
  readonly signal?: AbortSignal;
  /** Between two looks at an import's progress (for tests; default 2 s). */
  readonly pollMs?: number;
  /** The credential, instead of the session file (for tests). */
  readonly credential?: ApiCredential;
  /** The source, instead of the fixture file `--items` names (for tests). */
  readonly source?: ItemSource;
  /** With `--listen`: told the address once it listens (for tests). */
  readonly onListening?: (address: { host: string; port: number }) => void;
  /** With `--listen`: the shortest gap between two runs' starts (for tests; default 1 min). */
  readonly triggerGapMs?: number;
}

/** The connector's command line; resolves to its exit code (once: 0 when the run ended well). */
export async function runCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        mapping: { type: 'string' },
        items: { type: 'string' },
        every: { type: 'string' },
        listen: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (!values.mapping || (!values.items && !deps.source)) {
    io.err(USAGE);
    return 2;
  }
  const every = values.every === undefined ? undefined : Number(values.every);
  if (
    every !== undefined &&
    !(Number.isInteger(every) && every >= 1 && every <= 1440)
  ) {
    io.err('--every is a whole number of minutes from 1 to 1440.');
    return 2;
  }
  const listen =
    values.listen === undefined ? undefined : parseListen(values.listen);
  if (values.listen !== undefined && !listen) {
    io.err('--listen is a port, or <host>:<port>.');
    return 2;
  }
  const secret = env['CCMS_CONNECTOR_WEBHOOK_SECRET'];
  if (listen && (!secret || secret.length < TRIGGER_SECRET_MIN_LENGTH)) {
    io.err(
      `With --listen, set CCMS_CONNECTOR_WEBHOOK_SECRET to a secret of at least ${TRIGGER_SECRET_MIN_LENGTH} characters (e.g. openssl rand -hex 32).`,
    );
    return 2;
  }
  const url = env['CCMS_CONNECTOR_API_URL'];
  const sessionFile = env['CCMS_CONNECTOR_SESSION_FILE'];
  if (!url || (!sessionFile && !deps.credential)) {
    io.err('Set CCMS_CONNECTOR_API_URL and CCMS_CONNECTOR_SESSION_FILE.');
    return 2;
  }
  if (sessionFile && !deps.credential) {
    const mode = (await stat(sessionFile).catch(() => undefined))?.mode;
    if (mode === undefined) {
      io.err(`The session file ${sessionFile} cannot be read.`);
      return 2;
    }
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      io.err(
        `The session file ${sessionFile} is readable by others: it acts as you. Make it yours alone (chmod 600).`,
      );
      return 2;
    }
  }
  const mapping = TrackerMapping.safeParse(
    parseYaml(await readFile(values.mapping, 'utf8')) ?? {},
  );
  if (!mapping.success) {
    io.err(
      `The mapping ${values.mapping} is not valid:\n${mapping.error.issues.map((i) => `  ${i.path.join('.') || '(top)'}: ${i.message}`).join('\n')}`,
    );
    return 2;
  }
  let api: ImportApi;
  try {
    api = new ImportApi({
      baseUrl: url,
      // Read again on every request: signing in again renews it without a restart.
      credential: deps.credential ?? {
        get session() {
          return sessionOf(sessionFile as string, apiBaseUrl(url).hostname);
        },
      },
      ...(deps.fetch && { fetch: deps.fetch }),
    });
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const source = deps.source ?? new FixtureSource(values.items as string);
  const once = async (): Promise<boolean> => {
    try {
      const result = await runOnce({
        source,
        mapping: mapping.data,
        api,
        ...(deps.pollMs !== undefined && { pollMs: deps.pollMs }),
      });
      io.out(describe(result));
      // Held: nothing wrong, the next run after that review picks it up.
      return result.outcome !== 'refused' && result.outcome !== 'failed';
    } catch (error) {
      // Never the session: only the API's status and code, or the local error.
      io.err(
        error instanceof ApiError
          ? error.message
          : `The run failed: ${(error as Error).message}`,
      );
      return false;
    }
  };
  const signal = deps.signal ?? new AbortController().signal;
  const sleep = deps.sleep ?? abortableSleep;
  if (listen) {
    return listenForTriggers(listen, secret as string, {
      once,
      every,
      signal,
      sleep,
      io,
      deps,
    });
  }
  if (every === undefined) return (await once()) ? 0 : 1;
  while (!signal.aborted) {
    await once();
    if (signal.aborted) break;
    await sleep(every * 60_000, signal);
  }
  return 0;
}

export function describe(result: RunResult): string {
  switch (result.outcome) {
    case 'nothing-new':
      return `Nothing new: ${result.counts.skip} items unchanged.`;
    case 'refused':
      return `Not imported: ${result.counts.refuse} refused.\n${result.reasons.map((r) => `  ${r}`).join('\n')}`;
    case 'held':
      return `Not imported yet: ${result.held.length} of what changed is held by an open change set (${[...new Set(result.held.map((h) => h.changeSetId))].join(', ')}); the first run after it is merged or abandoned imports it.`;
    case 'imported':
      return `Imported ${result.counts.create} new and ${result.counts.update} changed items into change set ${result.changeSetId} (${result.changeSetState}).`;
    case 'failed':
      return `Import ${result.importId} failed: ${result.failure.code}: ${result.failure.detail}${result.changeSetId ? `\n  What it wrote is in change set ${result.changeSetId}; abandon it (POST /change-sets/${result.changeSetId}/abandon), or later runs wait for it.` : ''}`;
  }
}

/**
 * Listens for triggers until `signal` aborts: each signed `POST /trigger`
 * queues a run (answered at once), and with `every` the schedule queues one
 * too, so a scheduled run and a triggered one never overlap. On stop it
 * closes the listener, drops a run still waiting and lets the one under
 * way finish.
 */
async function listenForTriggers(
  address: { host: string; port: number },
  secret: string,
  context: {
    once: () => Promise<boolean>;
    every: number | undefined;
    signal: AbortSignal;
    sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    io: CliIo;
    deps: CliDeps;
  },
): Promise<number> {
  const { once, every, signal, sleep, io, deps } = context;
  const queue = new RunQueue({
    run: async () => {
      await once();
    },
    minGapMs: deps.triggerGapMs ?? TRIGGER_MIN_GAP_MS,
  });
  const server = createTriggerListener({ secret, queue, log: io.out });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address.port, address.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    io.err(
      `Cannot listen on ${address.host}:${address.port}: ${(error as Error).message}`,
    );
    return 2;
  }
  const bound = server.address();
  const port = typeof bound === 'object' && bound ? bound.port : address.port;
  const host = address.host.includes(':') ? `[${address.host}]` : address.host;
  // An accept failure (too many open files, say) is printed, not fatal.
  server.on('error', (error) =>
    io.err(`The trigger listener: ${error.message}`),
  );
  io.out(`Listening for triggers on http://${host}:${port}${TRIGGER_PATH}.`);
  deps.onListening?.({ host: address.host, port });
  // On stop, at once: no trigger is taken any more and a waiting run is
  // dropped, whatever the schedule is waiting for.
  const stopped = new Promise<void>((resolve) => {
    const stop = () => {
      server.close(() => resolve());
      server.closeAllConnections();
      void queue.stop();
    };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
  if (every !== undefined) {
    while (!signal.aborted) {
      queue.request();
      await queue.idle();
      if (signal.aborted) break;
      await sleep(every * 60_000, signal);
    }
  }
  await stopped;
  await queue.stop();
  return 0;
}

/** The session in the cookie file, read now; a missing one is an error naming what to do. */
function sessionOf(file: string, host: string): string {
  const session = readSessionCookie(readFileSync(file, 'utf8'), host);
  if (!session) {
    throw new Error(
      `${file} holds no current session: sign in again (the import format's guide, "Sign in for the import").`,
    );
  }
  return session;
}
