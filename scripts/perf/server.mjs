// Starts the built API (`backend/api/dist/main.js`) on a profile's data, as a deployment runs
// it, and talks to it. Used by the seed (the parts written through the API) and by the
// benchmarks (`api:perf-scale`, the editor timings).

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { API_DIR, profilePaths } from './paths.mjs';

/** A free TCP port on 127.0.0.1 (the system's choice). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * The server's settings for a profile. Built from nothing but the system's basics, never from
 * this process's environment, so a checkout's local settings (which Nx hands its tasks) can
 * never point the measured server at other content or another database.
 */
export function serverEnv(state, port, overrides = {}) {
  const paths = profilePaths(state.profile);
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'SystemRoot'];
  return {
    ...Object.fromEntries(
      keep
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]]),
    ),
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    CCMS_CONTENT_DIR: paths.content,
    CCMS_DEFAULT_REF: 'main',
    CCMS_API_TOKEN: state.token,
    // Demo mode: requests name the seeded user they act as (`X-Ccms-User`), so the seed and
    // the benchmarks act as authors, reviewers and readers with their real scopes.
    CCMS_AUTH_MODE: 'demo',
    CCMS_AUTH_FAILURES_MAX: '0',
    CCMS_DATABASE_URL: state.databaseUrl,
    CCMS_BLOB_DRIVER: 'fs',
    CCMS_BLOB_FS_ROOT: paths.blobs,
    CCMS_WEBHOOKS_SECRET_KEY: state.webhooksKey,
    CCMS_WEBHOOKS_ALLOW_HTTP: 'true',
    CCMS_WEBHOOKS_ALLOW_PRIVATE: 'true',
    // Nothing runs on a timer unless asked: webhooks would send to receivers that are not
    // there, and the notifications' fan-out would compete with what is measured.
    CCMS_WEBHOOKS_POLL_MS: '0',
    CCMS_NOTIFICATIONS_POLL_MS: '0',
    CCMS_STYLE_REVIEW_URL: '',
    ...overrides,
  };
}

/**
 * Starts the API on the profile and waits until `GET /health/ready` answers 200.
 * `startupMs` is from the spawn to that answer.
 */
export async function startServer(
  state,
  { port, env = {}, label = 'server', timeoutMs = 600_000 } = {},
) {
  const paths = profilePaths(state.profile);
  mkdirSync(paths.logs, { recursive: true });
  const usedPort = port ?? (await freePort());
  const log = createWriteStream(join(paths.logs, `${label}.log`), {
    flags: 'a',
  });
  const started = performance.now();
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: API_DIR,
    env: serverEnv(state, usedPort, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited;
  const exit = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    }),
  );
  const base = `http://127.0.0.1:${usedPort}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) {
      throw new Error(
        `perf: the API exited during start-up (${JSON.stringify(exited)}); see ${join(paths.logs, `${label}.log`)}`,
      );
    }
    try {
      const res = await fetch(`${base}/health/ready`);
      if (res.status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(
        `perf: the API did not become ready within ${timeoutMs} ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const startupMs = performance.now() - started;
  return {
    base,
    port: usedPort,
    pid: child.pid,
    startupMs,
    client: new ApiClient(base, state.token),
    async stop() {
      if (!exited) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        await exit;
        clearTimeout(timer);
      }
      log.end();
    },
  };
}

export const JSON_API = 'application/vnd.api+json';

/** A small JSON:API client acting as a seeded user (demo mode). */
export class ApiClient {
  constructor(base, token) {
    this.base = base;
    this.token = token;
  }

  headers(as, body) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: JSON_API,
      ...(as && { 'X-Ccms-User': as }),
      ...(body !== undefined && {
        'Content-Type': JSON_API,
        'X-Ccms-Request': '1',
      }),
    };
  }

  /**
   * One request; resolves to `{ status, body, ms, bytes, headers }` (`body` parsed when JSON).
   * `as`: the seeded user to act as (none: the shared token's read-only service); `signal`
   * bounds it.
   */
  async request(
    method,
    path,
    { as, body, raw = false, headers = {}, signal } = {},
  ) {
    const started = performance.now();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...this.headers(as, body),
        ...(method !== 'GET' &&
          method !== 'HEAD' && {
            'X-Ccms-Request': '1',
            'Content-Type': JSON_API,
          }),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal,
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const ms = performance.now() - started;
    const type = res.headers.get('content-type') ?? '';
    let parsed;
    if (type.includes('json')) {
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        parsed = undefined;
      }
    }
    return {
      status: res.status,
      body: parsed,
      ms,
      bytes: bytes.length,
      headers: res.headers,
    };
  }

  get(path, options) {
    return this.request('GET', path, options);
  }

  /** A request that must answer one of `ok` (default 2xx); throws with the error document otherwise. */
  async must(method, path, options = {}, ok = (s) => s >= 200 && s < 300) {
    const res = await this.request(method, path, options);
    if (!ok(res.status)) {
      throw new Error(
        `perf: ${method} ${path} answered ${res.status}: ${JSON.stringify(res.body?.errors ?? res.body)?.slice(0, 800)}`,
      );
    }
    return res;
  }
}
