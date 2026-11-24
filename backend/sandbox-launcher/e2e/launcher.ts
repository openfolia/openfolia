// A launcher on fake sandboxes, on a port of its own, for the browser tests.
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAssets } from '../src/assets.js';
import { silentLogger } from '../src/log.js';
import { Sandboxes } from '../src/sandboxes.js';
import { createLauncherServer } from '../src/server.js';
import { launcherSettings } from '../src/settings.js';
import { FakeRuntime } from '../tests/fakes.js';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

/** A folder with stand-ins for the demo's films: a poster and a video file each. */
export function filmsDir(poster: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-films-'));
  for (const name of [
    'hero',
    'editor',
    'review',
    'manual-builder',
    'releases',
  ]) {
    writeFileSync(join(dir, `${name}-en.jpg`), poster);
    writeFileSync(join(dir, `${name}-en.mp4`), Buffer.alloc(16));
  }
  return dir;
}

export interface TestLauncher {
  readonly url: string;
  readonly runtime: FakeRuntime;
  readonly sandboxes: Sandboxes;
  close(): Promise<void>;
}

export async function startLauncher(
  env: Record<string, string> = {},
): Promise<TestLauncher> {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const settings = launcherSettings({
    CCMS_LAUNCHER_PUBLIC_URL: url,
    CCMS_LAUNCHER_AGENT_URL: 'http://agent:8081',
    CCMS_LAUNCHER_AGENT_TOKEN: 'a'.repeat(64),
    CCMS_LAUNCHER_POW_BITS: '12',
    CCMS_LAUNCHER_RATE: '1000',
    CCMS_LAUNCHER_PER_ADDRESS: '10',
    CCMS_LAUNCHER_PER_ADDRESS_DAILY: '100',
    CCMS_LAUNCHER_DOCS_URL: 'https://docs.example.org/',
    ...env,
  });
  const runtime = new FakeRuntime();
  const sandboxes = new Sandboxes(runtime, settings, silentLogger);
  const server: Server = createLauncherServer({
    settings,
    sandboxes,
    assets: loadAssets(),
    log: silentLogger,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );
  return {
    url,
    runtime,
    sandboxes,
    close: async () => {
      server.close();
      server.closeAllConnections();
      await runtime.stopAll();
    },
  };
}
