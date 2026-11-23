import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { withTimeout } from '../../database/database.js';
import {
  JobsOverview,
  lagSeconds,
  levelOf,
} from '../../jobs/core/job-consumers.js';
import {
  CheckHealthAction,
  type HealthReport,
} from '../core/actions/check-health.action.js';

/** How long the queue's reading may take before the health answer goes without it. */
const QUEUE_TIMEOUT_MS = 2_000;
/** How long one health reading answers the checks after it (single flight). */
const REPORT_REUSE_MS = 1_000;
/** What `Retry-After` tells a client of a 503 from `/health/ready`. */
const NOT_READY_RETRY_SECONDS = 5;

/** The worker's health (#527): the API's report, and where the job queue stands. */
export interface WorkerHealth extends HealthReport {
  role: 'worker';
  /**
   * The job queue: jobs due and waiting (`ready`), attempts running, how
   * long the longest-waiting one has waited (`lagSeconds`), the consumers
   * heard from in the last minute, and `level` (`warning`: jobs waited
   * five minutes while none was consumed). Null when it cannot be read.
   */
  queue: {
    ready: number;
    running: number;
    lagSeconds: number;
    consumers: number;
    level: 'ok' | 'warning';
  } | null;
}

/** Where the providers the server needs come from: the worker's application context. */
export interface WorkerHealthSources {
  get<T>(type: abstract new (...args: never[]) => T): T;
}

/**
 * The worker's only HTTP surface (#527): `GET /health` (liveness: always
 * 200 while the process runs) and `GET /health/ready` (readiness: 200 when
 * the database and the blob store answer and the pool has a connection,
 * else a JSON:API 503 error), as the API answers them, plus the job
 * queue's lag. No token (like the API's health routes): it names nothing
 * of the content. Anything else is 404, any other method 405 (`HEAD`
 * answers as `GET`, without a body); a request body is never read. Plain
 * `node:http`, no framework: the worker has no routes, guards or body
 * parsers to keep safe. Bind it to the loopback interface where only the
 * container's own health check needs it (`HOST=127.0.0.1`).
 */
export async function startWorkerHealthServer(
  sources: WorkerHealthSources,
  {
    host,
    port,
    reuseMs = REPORT_REUSE_MS,
  }: { host: string; port: number; reuseMs?: number },
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const checkHealth = sources.get(CheckHealthAction);
  const overview = sources.get(JobsOverview);
  const logger = new Logger('WorkerHealth');

  // One reading at a time, and its answer reused for `reuseMs` after it
  // settled: a burst of checks, or checks against a slow database, cost one.
  let pending: Promise<WorkerHealth> | undefined;
  let settled: { at: number; report: WorkerHealth } | undefined;
  const report = (): Promise<WorkerHealth> => {
    if (settled && Date.now() - settled.at < reuseMs) {
      return Promise.resolve(settled.report);
    }
    pending ??= read().then(
      (health) => {
        settled = { at: Date.now(), report: health };
        pending = undefined;
        return health;
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };

  const read = async (): Promise<WorkerHealth> => {
    const [health, queue] = await Promise.all([
      checkHealth.handle(),
      withTimeout(overview.status(), QUEUE_TIMEOUT_MS).then(
        (status) => ({
          ready: status.ready,
          running: status.running,
          lagSeconds: lagSeconds(status),
          consumers: status.consumers,
          level: levelOf(status),
        }),
        (error: unknown) => {
          logger.warn(`Reading the job queue failed: ${String(error)}`);
          return null;
        },
      ),
    ]);
    return { ...health, role: 'worker', queue };
  };

  const server = createServer(
    // Health checks only: small limits, and nothing kept open.
    { requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8_192 },
    (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      const send = (
        status: number,
        type: string,
        body: unknown,
        headers: Record<string, string> = {},
      ) => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          'Content-Type': type,
          'Content-Length': Buffer.byteLength(text),
          ...headers,
        });
        res.end(req.method === 'HEAD' ? undefined : text);
      };
      const error = (
        status: number,
        code: string,
        title: string,
        headers: Record<string, string> = {},
      ) =>
        send(
          status,
          'application/vnd.api+json',
          { errors: [{ status: String(status), code, title, detail: title }] },
          headers,
        );
      // The request's body (there should be none) is never read.
      req.resume();
      const path = pathOf(req);
      if (path !== '/health' && path !== '/health/ready') {
        error(404, 'not-found', 'Not found.');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        error(405, 'method-not-allowed', 'Only GET.', { Allow: 'GET, HEAD' });
        return;
      }
      void report().then(
        (health) => {
          if (path === '/health') {
            send(200, 'application/json', health);
            return;
          }
          const retry = { 'Retry-After': String(NOT_READY_RETRY_SECONDS) };
          if (health.database !== 'ok') {
            error(
              503,
              'database-unavailable',
              'The database does not answer.',
              retry,
            );
          } else if (health.blobs !== 'ok') {
            error(
              503,
              'blob-store-unavailable',
              'The blob store does not answer.',
              retry,
            );
          } else if (health.pool !== 'ok') {
            error(
              503,
              'database-saturated',
              'Every database connection is in use.',
              retry,
            );
          } else {
            send(200, 'application/json', health);
          }
        },
        (failure: unknown) => {
          logger.error('The health check failed', failure);
          error(500, 'internal-error', 'The health check failed.');
        },
      );
    },
  );
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const shown =
    address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${shown}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The request's path, without its query; '' when it cannot be read. */
function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '';
  if (!raw.startsWith('/')) return '';
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
}
