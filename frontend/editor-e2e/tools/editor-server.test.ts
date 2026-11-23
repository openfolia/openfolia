import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// The editor server (`stack/editor-server.mjs`) adds the API token to what it proxies, and the
// demo set-up runs it long on a fixed port: it must answer only to its own names (DNS rebinding).

const SERVER = join(import.meta.dirname, '..', 'stack', 'editor-server.mjs');
let dir: string;
let port: number;
let server: ChildProcess;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as { port: number };
      probe.close(() => resolve(free));
    });
  });

/** A request to the server with the given `Host` and headers: its status. */
const send = (path: string, headers: Record<string, string>, method = 'GET') =>
  new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers, setHost: false },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'editor-server-test-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><p>editor');
  port = await freePort();
  // The API address answers nothing: a refused request never gets that far.
  const apiPort = await freePort();
  server = spawn(process.execPath, [SERVER], {
    env: {
      E2E_EDITOR_PORT: String(port),
      E2E_API_URL: `http://127.0.0.1:${apiPort}`,
      E2E_API_TOKEN: 'secret',
      E2E_EDITOR_DIST: join(dir, 'dist'),
      E2E_EDITOR_START_PAGE: '1',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve) =>
    server.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve();
    }),
  );
});

after(() => {
  server.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
});

test('answers its own names', async () => {
  assert.equal(await send('/', { host: `127.0.0.1:${port}` }), 200);
  assert.equal(await send('/content', { host: `localhost:${port}` }), 200);
  assert.equal(
    await send('/__start?lang=de', { host: `127.0.0.1:${port}` }),
    200,
  );
});

test('refuses another name pointed at it, for the API, the start page and the files', async () => {
  for (const path of ['/api/change-sets', '/__start?lang=de', '/']) {
    assert.equal(await send(path, { host: `attacker.example:${port}` }), 421);
    assert.equal(
      await send(
        path,
        {
          host: `attacker.example:${port}`,
          origin: `http://attacker.example:${port}`,
        },
        'POST',
      ),
      421,
    );
  }
  // No `Host` at all: Node's HTTP server refuses that itself (HTTP/1.1 requires one).
  assert.equal(await send('/', {}), 400);
});

test('refuses a write from another origin, even to its own name', async () => {
  for (const origin of [
    'http://attacker.example',
    `http://attacker.example:${port}`,
    'null',
  ]) {
    assert.equal(
      await send(
        '/api/change-sets',
        { host: `127.0.0.1:${port}`, origin },
        'POST',
      ),
      403,
    );
  }
});
