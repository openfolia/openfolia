// The portal image's command (#819, deploy/docker/portal/): the web server given after `--`
// (Caddy, serving the output folder), and beside it the portal built from the API at start and
// rebuilt whenever a release is published or withdrawn (build/refresh.ts). The settings are the
// build's (.env.example, "Portal") and CCMS_PORTAL_REFRESH_SECONDS. Exits when the server does,
// and stops the server on SIGTERM or SIGINT.
//
//   node scripts/serve.ts -- caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
import { spawn } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient } from '../build/api-client.ts';
import {
  publishedReleases,
  readRefreshMs,
  refreshLoop,
  settingsKey,
  shownReleases,
  writeBuildRecord,
} from '../build/refresh.ts';
import { buildPortal, writeHoldingPage } from '../build/run.ts';
import { type PortalSettings, readSettings } from '../build/settings.ts';

const separator = process.argv.indexOf('--');
const server = separator === -1 ? [] : process.argv.slice(separator + 1);
const log = (line: string) => console.log(`portal: ${line}`);

function load(): { settings: PortalSettings; intervalMs: number } {
  try {
    if (server.length === 0)
      throw new Error('no web server given: serve.ts -- <command>');
    return {
      settings: readSettings(process.env, process.cwd()),
      intervalMs: readRefreshMs(process.env),
    };
  } catch (error) {
    // The message only: it names the setting, never a value.
    console.error(
      `portal: ${error instanceof Error ? error.message : 'invalid settings'}`,
    );
    process.exit(64);
  }
}
const { settings, intervalMs } = load();
// Held by the client only: neither the server nor a build's processes inherit it.
delete process.env['CCMS_PORTAL_TOKEN'];

// The server's environment: what it needs to run, nothing of the portal's settings.
const env: Record<string, string> = {};
for (const key of [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
])
  if (process.env[key] !== undefined) env[key] = process.env[key]!;
const child = spawn(server[0]!, server.slice(1), {
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

const stop = new AbortController();
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  stop.abort();
  child.kill('SIGTERM');
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
child.once('error', (error) => {
  console.error(`portal: the web server did not start: ${error.message}`);
  stop.abort();
  process.exit(1);
});
child.once('exit', (code, signal) => {
  // tini signals the whole group: the server may stop on that SIGTERM before this process does.
  if (signal === 'SIGTERM' || code === 0) stopping = true;
  if (!stopping)
    console.error(
      `portal: the web server stopped (${code ?? signal ?? 'unknown'})`,
    );
  stop.abort();
  process.exit(stopping ? 0 : (code ?? 1) || 1);
});

const client = new ApiClient(settings.apiUrl, settings.token);
const key = settingsKey(settings);
const holding = () => {
  writeHoldingPage(settings.outDir);
  writeBuildRecord(settings.outDir, key, '');
};
// A stop in the middle of a swap (build/run.ts, replaceOutput) left the last build beside it.
if (!existsSync(settings.outDir) && existsSync(`${settings.outDir}.old`))
  renameSync(`${settings.outDir}.old`, settings.outDir);
// A previous build made with other settings (a higher audience, say), or of which nothing is
// recorded, is never served: the holding page until this container's first build completes.
let shownAtStart = shownReleases(settings.outDir, key);
if (
  shownAtStart === undefined &&
  existsSync(join(settings.outDir, 'index.html'))
) {
  holding();
  shownAtStart = '';
}
log(
  `serving ${settings.outDir} for the audience "${settings.audience}"; the releases are read every ${intervalMs / 1000} s.`,
);
await refreshLoop({
  published: () => publishedReleases(client),
  build: async (releases) => {
    await buildPortal({ ...settings, log });
    writeBuildRecord(settings.outDir, key, releases);
  },
  holding,
  intervalMs,
  shownAtStart,
  log,
  signal: stop.signal,
});
