import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DiscoveryService } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { fromPglite } from 'pg-boss';
import { z } from 'zod';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { FakeJobConsumers } from '../../../tests/fakes/fake-job-consumers.js';
import type { Env } from '../../config/env.js';
import { ServerRole } from '../../config/server-role.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { JobWorker } from '../api/job-worker.js';
import { RunJobAction } from '../core/actions/run-job.action.js';
import { JobHandlers } from '../core/job-handlers.js';
import {
  defineJob,
  type JobContext,
  JobHandler,
  MAX_PAYLOAD_BYTES,
} from '../core/job.js';
import {
  JOBS_SCHEMA,
  PgBossJobClaims,
  PgBossJobQueue,
  PgBossJobs,
} from './pg-boss-jobs.js';

// Real pg-boss on PGlite (its own adapter): the queue's SQL, its retries, its
// attempt fence and its heartbeat expiry, as the server runs them. PGlite has
// one connection, so two servers claiming at once (SKIP LOCKED) is not tested
// here.

const kind = defineJob({
  name: 'test.render',
  payload: z.strictObject({ outputId: z.string() }),
  retryLimit: 1,
  retryDelaySeconds: 1,
});

class Handler extends JobHandler<{ outputId: string }> {
  readonly kind = kind;
  readonly ran: [string, JobContext][] = [];
  readonly failedFor: string[] = [];
  throwing = false;
  async run(payload: { outputId: string }, context: JobContext) {
    this.ran.push([payload.outputId, context]);
    if (this.throwing) throw new Error('render failed');
  }
  override async failed(payload: { outputId: string }) {
    this.failedFor.push(payload.outputId);
  }
}

/** One server's jobs component over `database`. */
async function server(database: PgliteDatabase, handler: Handler) {
  const handlers = new JobHandlers();
  const jobs = new PgBossJobs(
    {
      options: {
        db: fromPglite(database.client),
        backend: 'pglite',
        supervise: false,
        registerInstance: false,
      },
      migrate: true,
    },
    handlers,
    {
      getProviders: () => [{ instance: handler }, { instance: {} }],
    } as unknown as DiscoveryService,
  );
  await jobs.onModuleInit();
  const claims = new PgBossJobClaims(jobs);
  const worker = new JobWorker(
    handlers,
    claims,
    new RunJobAction(handlers),
    new FakeJobConsumers(),
    new ServerRole('all'),
    { get: () => 0 } as unknown as ConfigService<Env, true>,
  );
  return { jobs, queue: new PgBossJobQueue(jobs), claims, worker };
}

let database: PgliteDatabase;
let handler: Handler;
let s: Awaited<ReturnType<typeof server>>;
beforeEach(async () => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  database = await createTestDatabase();
  handler = new Handler();
  s = await server(database, handler);
});
afterEach(async () => {
  await s?.jobs.onApplicationShutdown();
  await database?.close();
  vi.restoreAllMocks();
});

/** Makes a job's retry due now (the queue waits at least a second). */
const dueNow = (id: string) =>
  database.db.execute(
    sql.raw(
      `update ${JOBS_SCHEMA}.job set start_after = now() - interval '1 second' where id = '${id}'`,
    ),
  );

it('enqueues in the caller’s transaction: none on rollback, one on commit', async () => {
  const unit = new DrizzleUnitOfWork(database);
  await expect(
    unit.run(async (tx) => {
      await s.queue.enqueue(kind, { outputId: 'a' }, { key: 'a', tx });
      throw new Error('rolled back');
    }),
  ).rejects.toThrow('rolled back');
  expect(await s.worker.drain()).toBe(0);

  const id = await unit.run((tx) =>
    s.queue.enqueue(kind, { outputId: 'a' }, { key: 'a', tx }),
  );
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await s.queue.find(kind, id!)).toMatchObject({
    id,
    kind: kind.name,
    key: 'a',
    state: 'queued',
    attempts: 0,
    endedAt: null,
  });
  // The same work again while it is open: nothing added.
  expect(await s.queue.enqueue(kind, { outputId: 'a' }, { key: 'a' })).toBe(
    undefined,
  );

  expect(await s.worker.drain()).toBe(1);
  expect(handler.ran.map(([id]) => id)).toEqual(['a']);
  expect(await s.queue.find(kind, id!)).toMatchObject({
    state: 'done',
    attempts: 1,
  });
  expect(await s.queue.latest(kind, 'a')).toMatchObject({
    id,
    kind: kind.name,
    key: 'a',
    state: 'done',
    attempts: 1,
  });
  // Ended: the key is free again.
  const again = await s.queue.enqueue(kind, { outputId: 'a' }, { key: 'a' });
  expect(again).toBeDefined();
  // The newest job of the key: the open one.
  expect(await s.queue.latest(kind, 'a')).toMatchObject({
    id: again,
    key: 'a',
    state: 'queued',
  });
  expect(await s.queue.latest(kind, 'none')).toBeUndefined();
  expect(await s.queue.latest(kind, '')).toBeUndefined();
});

it('claims the highest priority first, the oldest among equals, and raises a waiting job’s priority (#497)', async () => {
  await s.queue.enqueue(kind, { outputId: 'old' }, { key: 'old', priority: 5 });
  await s.queue.enqueue(kind, { outputId: 'new' }, { key: 'new', priority: 9 });
  await s.queue.enqueue(kind, { outputId: 'bulk' }, { key: 'bulk' });
  await s.queue.enqueue(
    kind,
    { outputId: 'old-2' },
    { key: 'old-2', priority: 5 },
  );
  // Someone waits for `bulk` now: ahead of all.
  expect(await s.queue.prioritize(kind, 'bulk', 10)).toBe(true);
  // Never lowered, and nothing for an unknown key.
  expect(await s.queue.prioritize(kind, 'new', 1)).toBe(false);
  expect(await s.queue.prioritize(kind, 'none', 10)).toBe(false);
  expect(await s.worker.drain()).toBe(4);
  expect(handler.ran.map(([id]) => id)).toEqual([
    'bulk',
    'new',
    'old',
    'old-2',
  ]);
  // Ended: left alone.
  expect(await s.queue.prioritize(kind, 'old', 20)).toBe(false);
  await expect(
    s.queue.enqueue(kind, { outputId: 'a' }, { key: 'a', priority: -1 }),
  ).rejects.toThrow('priority');
  await expect(
    s.queue.enqueue(kind, { outputId: 'a' }, { key: 'a', priority: 2 ** 31 }),
  ).rejects.toThrow('priority');
});

it('tells the keys with a job that has not ended (#497, #527)', async () => {
  await s.queue.enqueue(kind, { outputId: 'a' }, { key: 'a' });
  await s.queue.enqueue(kind, { outputId: 'b' }, { key: 'b' });
  expect(
    [...(await s.queue.openKeys(kind, ['a', 'b', 'c', 'a']))].sort(),
  ).toEqual(['a', 'b']);
  expect(await s.queue.openKeys(kind, [])).toEqual(new Set());
  expect(await s.queue.openKeys(kind, ['', 'x'.repeat(201)])).toEqual(
    new Set(),
  );
  expect(await s.worker.drain()).toBe(2);
  expect(await s.queue.openKeys(kind, ['a', 'b'])).toEqual(new Set());
});

it('refuses what it cannot queue', async () => {
  await expect(
    s.queue.enqueue(kind, { outputId: 1 } as never, { key: 'a' }),
  ).rejects.toThrow();
  await expect(
    s.queue.enqueue(
      kind,
      { outputId: 'x'.repeat(MAX_PAYLOAD_BYTES) },
      { key: 'a' },
    ),
  ).rejects.toThrow('larger than');
  await expect(
    s.queue.enqueue(kind, { outputId: 'a' }, { key: '' }),
  ).rejects.toThrow('key');
  const other = defineJob({ name: 'test.other', payload: z.object({}) });
  await expect(s.queue.enqueue(other, {}, { key: 'a' })).rejects.toThrow(
    'No job handler',
  );
  expect(await s.queue.find(kind, 'not-a-uuid')).toBeUndefined();
  expect(await s.queue.cancel(kind, 'not-a-uuid')).toBe(false);
});

it('retries a failure, then reports it to `failed` once', async () => {
  handler.throwing = true;
  const id = await s.queue.enqueue(kind, { outputId: 'b' }, { key: 'b' });
  expect(await s.worker.drain()).toBe(1);
  expect(await s.queue.find(kind, id!)).toMatchObject({ state: 'retrying' });
  await dueNow(id!);
  // The second attempt fails for good; its copy goes to the failed queue.
  expect(await s.worker.drain()).toBe(2);
  expect(handler.ran.map(([, c]) => [c.attempt, c.lastAttempt])).toEqual([
    [1, false],
    [2, true],
  ]);
  expect(handler.failedFor).toEqual(['b']);
  expect(await s.queue.find(kind, id!)).toMatchObject({
    state: 'failed',
    attempts: 2,
  });
});

it('cancels a job that has not run', async () => {
  const id = await s.queue.enqueue(kind, { outputId: 'c' }, { key: 'c' });
  expect(await s.queue.cancel(kind, id!)).toBe(true);
  expect(await s.queue.cancel(kind, id!)).toBe(false);
  expect(await s.worker.drain()).toBe(0);
  expect(await s.queue.find(kind, id!)).toMatchObject({ state: 'cancelled' });
});

it('never runs a stored payload its kind refuses', async () => {
  const id = await s.queue.enqueue(kind, { outputId: 'd' }, { key: 'd' });
  await database.db.execute(
    sql.raw(
      `update ${JOBS_SCHEMA}.job set data = '{"outputId": 1, "admin": true}' where id = '${id}'`,
    ),
  );
  expect(await s.worker.drain()).toBe(1);
  expect(handler.ran).toEqual([]);
  expect(await s.queue.find(kind, id!)).toMatchObject({ state: 'cancelled' });
});

it('survives a restart: a job queued before it runs after it', async () => {
  const id = await s.queue.enqueue(kind, { outputId: 'e' }, { key: 'e' });
  await s.jobs.onApplicationShutdown();
  const next = new Handler();
  s = await server(database, next);
  expect(await s.worker.drain()).toBe(1);
  expect(next.ran.map(([id]) => id)).toEqual(['e']);
  expect(await s.queue.find(kind, id!)).toMatchObject({ state: 'done' });
});

it('runs again what a server that died was running, once its heartbeat is missed', async () => {
  const id = await s.queue.enqueue(kind, { outputId: 'f' }, { key: 'f' });
  // A server claims it and dies: no settlement, no shutdown.
  const [claimed] = await s.claims.claim(kind.name, 1);
  expect(claimed?.id).toBe(id);
  const next = new Handler();
  const other = await server(database, next);
  try {
    expect(await other.worker.drain()).toBe(0);
    // Its heartbeat is long missed; maintenance hands the job back.
    await database.db.execute(
      sql.raw(
        `update ${JOBS_SCHEMA}.job set heartbeat_on = now() - interval '1 hour', started_on = now() - interval '1 hour' where id = '${id}'`,
      ),
    );
    await other.jobs.boss.supervise();
    await dueNow(id!);
    expect(await other.worker.drain()).toBe(1);
    expect(next.ran.map(([, c]) => c.attempt)).toEqual([2]);
    expect(await other.queue.find(kind, id!)).toMatchObject({ state: 'done' });
    // The dead server's attempt, settled late, changes nothing.
    expect(await s.claims.complete(claimed!)).toBe(false);
    expect(await s.claims.fail(claimed!, 'late')).toBe(false);
    expect(await s.claims.touch(claimed!)).toBe(false);
  } finally {
    await other.jobs.onApplicationShutdown();
  }
});

it('hands an attempt back unrun without counting it, fenced to that attempt', async () => {
  const id = await s.queue.enqueue(kind, { outputId: 'g' }, { key: 'g' });
  const [claimed] = await s.claims.claim(kind.name, 1);
  expect(await s.claims.release(claimed!)).toBe(true);
  expect(await s.claims.release(claimed!)).toBe(false);
  expect(await s.queue.find(kind, id!)).toMatchObject({
    state: 'queued',
    attempts: 0,
  });
  expect(await s.worker.drain()).toBe(1);
  expect(handler.ran.map(([, c]) => c.attempt)).toEqual([1]);
});
