import { Logger } from '@nestjs/common';
import { request } from 'node:http';
import {
  JobsOverview,
  type JobsStatus,
} from '../../jobs/core/job-consumers.js';
import {
  CheckHealthAction,
  type HealthReport,
} from '../core/actions/check-health.action.js';
import { startWorkerHealthServer } from './worker-health.server.js';

const healthy: HealthReport = {
  status: 'ok',
  database: 'ok',
  pool: 'ok',
  blobs: 'ok',
};

const now = new Date('2026-11-20T10:00:00Z');
let report: HealthReport;
let queue: JobsStatus | Error;

const sources = {
  get<T>(type: abstract new (...args: never[]) => T): T {
    if (type === (CheckHealthAction as unknown)) {
      return { handle: async () => report } as T;
    }
    if (type === (JobsOverview as unknown)) {
      return {
        status: async () => {
          if (queue instanceof Error) throw queue;
          return queue;
        },
      } as T;
    }
    throw new Error('unexpected');
  },
};

let server: Awaited<ReturnType<typeof startWorkerHealthServer>>;
beforeAll(async () => {
  server = await startWorkerHealthServer(sources, {
    host: '127.0.0.1',
    port: 0,
    // Each test changes what the sources answer: no reuse (tested below).
    reuseMs: 0,
  });
});
afterAll(() => server.close());
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  report = healthy;
  queue = {
    checkedAt: now,
    consumers: 2,
    lastConsumedAt: now,
    ready: 3,
    running: 1,
    oldestReadyAt: new Date(now.getTime() - 42_000),
  };
});
afterEach(() => vi.restoreAllMocks());

/** One raw request: status, headers and body text. */
function call(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${server.url}${path}`, { method }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('the worker’s health server (#527)', () => {
  it('answers liveness with the health report and the queue’s lag', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(res.text)).toEqual({
      ...healthy,
      role: 'worker',
      queue: {
        ready: 3,
        running: 1,
        lagSeconds: 42,
        consumers: 2,
        level: 'ok',
      },
    });
  });

  it('answers readiness 200 when healthy, 503 with Retry-After when the database is not', async () => {
    expect((await call('GET', '/health/ready?probe=1')).status).toBe(200);
    report = { ...healthy, status: 'degraded', database: 'unavailable' };
    const down = await call('GET', '/health/ready');
    expect(down.status).toBe(503);
    expect(down.headers['retry-after']).toBe('5');
    expect(down.headers['content-type']).toBe('application/vnd.api+json');
    expect(JSON.parse(down.text).errors[0].code).toBe('database-unavailable');
    // Liveness stays 200: restarting would not bring the database back.
    expect((await call('GET', '/health')).status).toBe(200);
  });

  it('answers without the queue when it cannot be read', async () => {
    queue = new Error('no connection');
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).queue).toBeNull();
  });

  it('has no other route and takes no other method', async () => {
    for (const path of [
      '/',
      '/manuals',
      '/health/',
      '/health/ready/x',
      '/docs',
      '/openapi.json',
      '//health',
      'http://x/health',
    ]) {
      const res = await call('GET', path.startsWith('/') ? path : `/${path}`);
      expect(res.status, path).toBe(404);
      expect(res.text).not.toContain('worker');
    }
    const post = await call('POST', '/health', '{"a":1}');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    const head = await call('HEAD', '/health');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
  });

  it('reads once for a burst of checks, and again once the answer is older than the window', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const counted = {
      get<T>(type: abstract new (...args: never[]) => T): T {
        if (type === (CheckHealthAction as unknown)) {
          return {
            handle: async () => {
              reads += 1;
              // Held until the burst is in: they all share this reading.
              await new Promise<void>((resolve) => (release = resolve));
              return report;
            },
          } as T;
        }
        return sources.get(type);
      },
    };
    const other = await startWorkerHealthServer(counted, {
      host: '127.0.0.1',
      port: 0,
      reuseMs: 100,
    });
    let arrived = 0;
    other.server.on('request', () => (arrived += 1));
    try {
      const get = () => fetch(`${other.url}/health`).then((r) => r.status);
      const burst = Promise.all([get(), get(), get()]);
      while (arrived < 3 || reads === 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
      release();
      expect(await burst).toEqual([200, 200, 200]);
      expect(reads).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const again = get();
      while (reads === 1) await new Promise((r) => setTimeout(r, 10));
      release();
      expect(await again).toBe(200);
      expect(reads).toBe(2);
    } finally {
      release();
      await other.close();
    }
  });
});
