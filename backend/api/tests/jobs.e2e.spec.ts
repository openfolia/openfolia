import { Injectable, Logger, Module } from '@nestjs/common';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { JSON_API } from '../src/base/api/json-api.js';
import { JobsStatusDocument } from '../src/jobs/api/jobs-status.resources.js';
import { JobConsumers, STALL_SECONDS } from '../src/jobs/core/job-consumers.js';
import { JobQueue } from '../src/jobs/core/job-queue.js';
import {
  defineJob,
  type JobContext,
  JobHandler,
} from '../src/jobs/core/job.js';
import { actorWith } from './fakes/actors.js';
import { createTestDatabase, PgliteDatabase } from './database.js';
import { createTestApp, type TestApp } from './test-app.js';

// The jobs component in the full app (#41): a component's handler is found
// among the app's providers, jobs outlive the server that queued them, and
// shutdown hands a running job back to the queue. No routes: a component
// shows its jobs' progress in its own resources.

const kind = defineJob({
  name: 'test.e2e',
  payload: z.strictObject({ n: z.number() }),
  retryDelaySeconds: 1,
});

/** What every app's handler saw, across apps. */
const seen: { n: number; attempt: number }[] = [];
/** While set, an attempt waits for it (or for its signal). */
let hold: Promise<void> | undefined;

@Injectable()
class TestHandler extends JobHandler<{ n: number }> {
  readonly kind = kind;
  async run(payload: { n: number }, context: JobContext) {
    seen.push({ n: payload.n, attempt: context.attempt });
    if (hold) {
      await Promise.race([
        hold,
        new Promise((resolve) =>
          context.signal.addEventListener('abort', resolve),
        ),
      ]);
    }
  }
}

@Module({ providers: [TestHandler] })
class TestJobsModule {}

/** The same PGlite for several apps in turn: closing one app leaves it open. */
class SharedDatabase extends PgliteDatabase {
  override async close(): Promise<void> {
    // The test closes the real one.
  }
}

let database: PgliteDatabase;
let t: TestApp | undefined;
beforeEach(async () => {
  seen.length = 0;
  hold = undefined;
  database = await createTestDatabase();
});
afterEach(async () => {
  await t?.close();
  t = undefined;
  await database?.close();
});

const app = (env: Record<string, string> = {}) =>
  createTestApp(env, {
    database: new SharedDatabase(database.client),
    imports: [TestJobsModule],
  });

it('runs a component’s job, enqueued through the app’s queue', async () => {
  t = await app();
  const queue = t.app.get(JobQueue);
  const id = await queue.enqueue(kind, { n: 1 }, { key: 'one' });
  expect(await t.runJobs()).toBe(1);
  expect(seen).toEqual([{ n: 1, attempt: 1 }]);
  expect(await queue.find(kind, id!)).toMatchObject({ state: 'done' });
});

it('keeps a job across a restart of the API', async () => {
  t = await app();
  const id = await t.app.get(JobQueue).enqueue(kind, { n: 2 }, { key: 'two' });
  await t.close();
  t = await app();
  expect(await t.runJobs()).toBe(1);
  expect(seen).toEqual([{ n: 2, attempt: 1 }]);
  expect(await t.app.get(JobQueue).find(kind, id!)).toMatchObject({
    state: 'done',
  });
});

it('hands a job still running at shutdown back to the queue, and runs it again after', async () => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  hold = new Promise(() => undefined);
  t = await app();
  const id = await t.app
    .get(JobQueue)
    .enqueue(kind, { n: 3 }, { key: 'three' });
  // Runs until the app shuts down (`drain` claims as the timer does).
  const running = t.runJobs();
  await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 15_000 });
  await t.close();
  t = undefined;
  expect(await running).toBe(1);

  hold = undefined;
  t = await app();
  const queue = t.app.get(JobQueue);
  // Back in the queue at once, and the cut-off attempt does not count.
  expect(await queue.find(kind, id!)).toMatchObject({
    state: 'queued',
    attempts: 0,
  });
  expect(await t.runJobs()).toBe(1);
  expect(seen).toEqual([
    { n: 3, attempt: 1 },
    { n: 3, attempt: 1 },
  ]);
  expect(await queue.find(kind, id!)).toMatchObject({ state: 'done' });
}, 40_000);

// -- Roles and the background work's state (#527) ---------------------------------------------

const admin: Actor = { ...actorWith(['admin.roles']), id: 'sample-admin' };

async function status(app: TestApp) {
  app.actAs(admin);
  const res = await app.get('/jobs/status');
  app.actAs(undefined);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe(JSON_API);
  return JobsStatusDocument.parse(res.body).data;
}

describe('GET /jobs/status', () => {
  it('tells an administrator the jobs due, the consumers and a warning when nothing takes them', async () => {
    t = await app();
    const empty = await status(t);
    expect(empty).toMatchObject({
      type: 'JobsStatus',
      id: 'jobs',
      attributes: { consumers: 0, ready: 0, running: 0, oldestReadyAt: null },
      meta: { lagSeconds: 0, level: 'ok', stallSeconds: STALL_SECONDS },
    });

    await t.app.get(JobQueue).enqueue(kind, { n: 1 }, { key: 'waits' });
    const waiting = await status(t);
    expect(waiting.attributes.ready).toBe(1);
    expect(waiting.attributes.oldestReadyAt).not.toBeNull();
    expect(waiting.meta.level).toBe('ok');

    // Due for ten minutes, and no consumer: a warning.
    await database.db.execute(
      sql`update pgboss.job set start_after = now() - interval '10 minutes', created_on = now() - interval '10 minutes' where name = ${kind.name}`,
    );
    const stalled = await status(t);
    expect(stalled.meta.lagSeconds).toBeGreaterThanOrEqual(600);
    expect(stalled.meta.level).toBe('warning');

    // A consumer that consumed just now: it is taken, no warning.
    const consumers = t.app.get(JobConsumers);
    const beat = {
      id: '0190a3a0-0000-7000-8000-000000000001',
      role: 'worker' as const,
      host: 'worker-1',
      pid: 42,
      startedAt: new Date(),
    };
    await consumers.beat({ ...beat, consumed: false });
    const seen = await status(t);
    expect(seen.attributes.consumers).toBe(1);
    expect(seen.attributes.lastConsumedAt).toBeNull();
    expect(seen.meta.level).toBe('warning');
    await consumers.beat({ ...beat, consumed: true });
    const taken = await status(t);
    expect(taken.attributes.lastConsumedAt).not.toBeNull();
    expect(taken.meta.level).toBe('ok');
    await consumers.leave(beat.id);
    expect((await status(t)).attributes.consumers).toBe(0);
  });

  it('is for administrators only', async () => {
    t = await app();
    t.actAs(actorWith(['content.read']));
    const res = await t.get('/jobs/status');
    t.actAs(undefined);
    expect(res.status).toBe(403);
    expect(res.body.errors[0].code).toBe('forbidden');
  });
});
