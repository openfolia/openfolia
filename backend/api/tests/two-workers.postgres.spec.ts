import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createBareSampleRepo } from '@openfolia/content-repo/testing';
import { PROMOTED_PER_RELEASE } from '../src/releases/core/release-output.js';
import { TEST_SECRET_KEY, TOKEN } from './test-app.js';

/**
 * Two workers rendering a release's outputs (#527), as a deployment runs them: the built
 * server (`dist/main.js`) in four processes on one real Postgres, two `CCMS_ROLE=api` (one
 * migrates, both serve) and two `CCMS_ROLE=worker`. Two releases of one product: every output
 * is done after at most one attempt, each file is rendered once for both (the second release
 * shares the first's), at most one render at a time per worker (its
 * `CCMS_RENDER_CONCURRENCY`), at most `PROMOTED_PER_RELEASE` of a release moved up at once
 * although both APIs are asked for every file together, and the APIs consume nothing.
 *
 * PGlite lives in one process, so this needs a server: it runs only when `CCMS_TEST_PG_URL`
 * names one (the compose Postgres, `postgres://ccms:ccms@127.0.0.1:5432/ccms`), in a database
 * of its own (`ccms_zz_workers_<random>`) that it creates and drops; without it, it is skipped.
 * It starts the build as it is: run `pnpm nx build api` first.
 */
const url = process.env['CCMS_TEST_PG_URL'];
const API_DIR = join(import.meta.dirname, '..');
const MAIN = join(API_DIR, 'dist', 'main.js');

vi.setConfig({ testTimeout: 240_000, hookTimeout: 180_000 });

interface Server {
  readonly name: string;
  readonly base: string;
  readonly child: ChildProcess;
  readonly log: string[];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

const until = async (
  what: string,
  check: () => Promise<boolean>,
  ms: number,
) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe.skipIf(!url)(
  'two workers, two releases of one product (Postgres, four processes)',
  () => {
    const name = `ccms_zz_workers_${randomBytes(6).toString('hex')}`;
    const servers: Server[] = [];
    let db: pg.Pool | undefined;
    let contentDir: string | undefined;
    let blobRoot: string | undefined;
    let databaseUrl = '';
    /** A service account's token with a role to publish and read: cuts the release, reads its files. */
    let publisher = '';

    const admin = () => new pg.Client({ connectionString: url });

    /** Starts `dist/main.js` in `role`, and waits for its `/health/ready`. */
    async function start(
      label: string,
      role: 'api' | 'worker',
      extra: Record<string, string> = {},
    ): Promise<Server> {
      const port = await freePort();
      // Nothing from this process's environment but the system's basics: never a checkout's
      // own settings (which Nx hands its tasks).
      const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ'];
      const env: Record<string, string> = {
        ...Object.fromEntries(
          keep.flatMap((k) =>
            process.env[k] === undefined ? [] : [[k, process.env[k] as string]],
          ),
        ),
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        CCMS_ROLE: role,
        CCMS_CONTENT_DIR: contentDir as string,
        CCMS_DEFAULT_REF: 'main',
        CCMS_API_TOKEN: TOKEN,
        CCMS_AUTH_MODE: 'token',
        CCMS_AUTH_FAILURES_MAX: '0',
        CCMS_DATABASE_URL: databaseUrl,
        CCMS_BLOB_DRIVER: 'fs',
        CCMS_BLOB_FS_ROOT: blobRoot as string,
        CCMS_SECRET_KEY: TEST_SECRET_KEY,
        CCMS_JOBS_POLL_MS: '500',
        CCMS_WEBHOOKS_POLL_MS: '0',
        CCMS_NOTIFICATIONS_POLL_MS: '0',
        CCMS_STYLE_REVIEW_URL: '',
        ...extra,
      };
      const child = spawn(process.execPath, [MAIN], {
        cwd: API_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const log: string[] = [];
      const keepLine = (chunk: Buffer) => {
        log.push(chunk.toString());
        if (log.length > 200) log.shift();
      };
      child.stdout?.on('data', keepLine);
      child.stderr?.on('data', keepLine);
      const server = {
        name: label,
        base: `http://127.0.0.1:${port}`,
        child,
        log,
      };
      servers.push(server);
      await until(
        `${label} to be ready`,
        async () => {
          if (child.exitCode !== null) {
            throw new Error(`${label} exited at start:\n${log.join('')}`);
          }
          try {
            return (await fetch(`${server.base}/health/ready`)).status === 200;
          } catch {
            return false;
          }
        },
        150_000,
      );
      return server;
    }

    const request = (
      server: Server,
      method: string,
      path: string,
      body?: unknown,
    ) =>
      fetch(`${server.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${publisher}`,
          Accept: 'application/vnd.api+json',
          ...(body !== undefined && {
            'Content-Type': 'application/vnd.api+json',
          }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });

    const count = async (query: string, values: unknown[] = []) =>
      (await (db as pg.Pool).query<{ n: number }>(query, values)).rows[0]?.n ??
      0;

    beforeAll(async () => {
      if (!existsSync(MAIN)) {
        throw new Error(`${MAIN} is missing: run pnpm nx build api first`);
      }
      const client = admin();
      await client.connect();
      try {
        await client.query(`create database ${name}`);
      } finally {
        await client.end();
      }
      const target = new URL(url as string);
      target.pathname = `/${name}`;
      databaseUrl = target.toString();
      contentDir = createBareSampleRepo().dir;
      blobRoot = mkdtempSync(join(tmpdir(), 'openfolia-two-workers-blobs-'));
      // The first API migrates; the others wait for it (a worker never migrates).
      await start('api-1', 'api');
      db = new pg.Pool({ connectionString: databaseUrl, max: 4 });
      await db.query(
        `insert into roles (id, name, permissions) values ('two-workers-publisher', 'Publisher', array['content.read', 'release.publish'])`,
      );
      publisher =
        execFileSync(
          process.execPath,
          [
            join(API_DIR, 'dist', 'database', 'service-token.main.js'),
            'two-workers-publisher',
            '--role',
            'two-workers-publisher',
          ],
          {
            cwd: API_DIR,
            env: { PATH: process.env['PATH'], CCMS_DATABASE_URL: databaseUrl },
            encoding: 'utf8',
          },
        )
          .trim()
          .split('\n')
          .at(-1) ?? '';
      await Promise.all([
        start('api-2', 'api'),
        ...[1, 2].map((n) =>
          start(`worker-${n}`, 'worker', {
            CCMS_PDF_WORKERS: '1',
            CCMS_RENDER_CONCURRENCY: '1',
          }),
        ),
      ]);
    });

    afterAll(async () => {
      await db?.end().catch(() => undefined);
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              if (s.child.exitCode !== null) return resolve();
              const timer = setTimeout(() => s.child.kill('SIGKILL'), 20_000);
              s.child.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
              s.child.kill('SIGTERM');
            }),
        ),
      );
      if (contentDir) rmSync(contentDir, { recursive: true, force: true });
      if (blobRoot) rmSync(blobRoot, { recursive: true, force: true });
      const client = admin();
      await client.connect();
      try {
        await client.query(`drop database if exists ${name} with (force)`);
      } finally {
        await client.end();
      }
    });

    it('renders every output once, within the caps, and only the workers consume', async () => {
      const [api1, api2] = servers.filter((s) => s.name.startsWith('api'));
      const cut = async (api: Server, revision: string) => {
        const res = await request(api, 'POST', '/releases', {
          data: { type: 'Release', attributes: { product: 'north', revision } },
        });
        expect(res.status, await res.clone().text()).toBe(201);
        return ((await res.json()) as { data: { id: string } }).data.id;
      };
      // Two releases of one product, the second cut through the other API once a worker has
      // taken the first's planning: the second is planned after it, in its product's turn
      // (#527, `PlanningTurns`; the sample plans in well under a second, so the turn itself
      // is shown by `session-lock.postgres.spec.ts`), and shares the first's files.
      const releaseId = await cut(api1 as Server, '1.0');
      await until(
        'a worker to plan the first release',
        async () =>
          (await count(
            `select count(*)::int as n from pgboss.job where name = 'release.plan-outputs' and state in ('active', 'completed')`,
          )) === 1 &&
          (await count(
            'select count(*)::int as n from release_outputs where release_id = $1',
            [releaseId],
          )) > 0,
        30_000,
      );
      const nextId = await cut(api2 as Server, '1.1');

      // Sampled while the releases render: renders at once (one per worker at most) and, per
      // release, outputs moved up and unfinished at once (the promotion cap).
      let rendering = 0;
      let promoted = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const [r, p] = await Promise.all([
            count(
              `select count(*)::int as n from release_outputs where state = 'rendering'`,
            ),
            count(
              `select coalesce(max(n), 0)::int as n from (select count(*) as n from release_outputs
               where promoted_at is not null and state in ('queued', 'rendering') group by release_id) per_release`,
            ),
          ]);
          rendering = Math.max(rendering, r);
          promoted = Math.max(promoted, p);
          await new Promise((r) => setTimeout(r, 50));
        }
      })();

      try {
        await until(
          'the outputs to be planned',
          async () =>
            (await count(
              'select count(*)::int as n from release_outputs where release_id = $1',
              [nextId],
            )) > PROMOTED_PER_RELEASE,
          60_000,
        );
        // Someone asks for every file of the newer release at once, through both APIs: each
        // still to render is moved up (409 output-not-ready meanwhile), at most
        // PROMOTED_PER_RELEASE of them.
        const ids = (
          await (db as pg.Pool).query<{ id: string }>(
            'select id from release_outputs where release_id = $1',
            [nextId],
          )
        ).rows.map((r) => r.id);
        const asked = await Promise.all(
          [api1, api2].flatMap((api) =>
            ids.map((id) =>
              request(
                api as Server,
                'GET',
                `/releases/${nextId}/outputs/${id}/file`,
              ),
            ),
          ),
        );
        for (const res of asked) expect([200, 409]).toContain(res.status);

        await until(
          'every output to be rendered',
          async () =>
            (await count(
              `select count(*)::int as n from release_outputs where state not in ('done', 'failed')`,
            )) === 0,
          180_000,
        );
      } finally {
        sampling = false;
        await sampler;
      }

      const outputs = (
        await (db as pg.Pool).query<{
          releaseId: string;
          state: string;
          attempts: number;
          sha256: string | null;
          reusedFrom: string | null;
          kind: string;
        }>(
          'select release_id as "releaseId", state, attempts, sha256, reused_from_output as "reusedFrom", kind from release_outputs',
        )
      ).rows;
      const first = outputs.filter((o) => o.releaseId === releaseId);
      expect(first.length).toBeGreaterThan(PROMOTED_PER_RELEASE);
      expect(outputs).toHaveLength(first.length * 2);
      // Each output rendered at most once (an attempt that found its group's file counts one).
      for (const output of outputs) {
        expect(output.state).toBe('done');
        expect(output.attempts).toBeLessThanOrEqual(1);
        expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // Each PDF once for both releases: the second planned after the first, sharing its
      // files (nothing in the sample content prints the release). The offline packages (#59)
      // name their release, so each release builds its own.
      const pdfs = outputs.filter((o) => o.kind === 'pdf');
      expect(pdfs.length).toBeGreaterThan(0);
      for (const o of outputs.filter((o) => o.kind === 'offline-package'))
        expect(o.reusedFrom).toBeNull();
      expect(pdfs.filter((o) => o.reusedFrom === null)).toHaveLength(
        first.filter((o) => o.kind === 'pdf').length,
      );
      expect(rendering).toBeGreaterThan(0);
      expect(rendering).toBeLessThanOrEqual(2);
      // Moved up while the others waited, never more than the cap.
      expect(promoted).toBeGreaterThan(0);
      expect(promoted).toBeLessThanOrEqual(PROMOTED_PER_RELEASE);

      // Only the workers consume: both alive, the APIs never in job_consumers.
      const roles = (
        await (db as pg.Pool).query<{ role: string }>(
          'select role from job_consumers order by role',
        )
      ).rows.map((r) => r.role);
      expect(roles).toEqual(['worker', 'worker']);
      // A worker records that it consumed with its next beat (every 15 s): both took files.
      await until(
        'both workers to record that they consumed',
        async () =>
          (await count(
            'select count(*)::int as n from job_consumers where consumed_at is not null',
          )) === 2,
        40_000,
      );
    });
  },
);
