import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { FakeJobQueue } from '../../../tests/fakes/fake-job-queue.js';
import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import { FakeJobConsumers } from '../../../tests/fakes/fake-job-consumers.js';
import type { Env } from '../../config/env.js';
import type { ServerRoleName } from '../../config/role.js';
import { ServerRole } from '../../config/server-role.js';
import { CONSUMER_BEAT_MS } from '../core/job-consumers.js';
import { RunJobAction } from '../core/actions/run-job.action.js';
import { HEARTBEAT_MS } from '../core/job-claims.js';
import { failedQueueOf, JobHandlers } from '../core/job-handlers.js';
import { defineJob, type JobContext, JobHandler } from '../core/job.js';
import { DRAIN_LIMIT, JobWorker, SHUTDOWN_WAIT_MS } from './job-worker.js';

const kind = defineJob({
  name: 'test.work',
  payload: z.strictObject({ n: z.number() }),
  retryLimit: 1,
  timeoutSeconds: 60,
  concurrency: 2,
});

/** Runs as told: `block` holds every attempt until released. */
class Handler extends JobHandler<{ n: number }> {
  readonly kind = kind;
  readonly ran: { n: number; context: JobContext }[] = [];
  readonly failedFor: number[] = [];
  throwing = false;
  block?: Promise<void>;

  async run(payload: { n: number }, context: JobContext) {
    this.ran.push({ n: payload.n, context });
    if (this.block) await this.block;
    if (this.throwing) throw new Error('boom');
  }

  override async failed(payload: { n: number }) {
    this.failedFor.push(payload.n);
  }
}

const config = (pollMs: number) =>
  ({ get: () => pollMs }) as unknown as ConfigService<Env, true>;

function setUp(pollMs = 0, role: ServerRoleName = 'all') {
  const consumers = new FakeJobConsumers();
  const queue = new FakeJobQueue();
  queue.failedQueues.set(kind.name, failedQueueOf(kind.name));
  const handler = new Handler();
  const handlers = new JobHandlers([handler]);
  const worker = new JobWorker(
    handlers,
    queue.claims,
    new RunJobAction(handlers),
    consumers,
    new ServerRole(role),
    config(pollMs),
  );
  return { queue, handler, worker, consumers };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('JobWorker.drain', () => {
  it('runs what is due until nothing is left, and settles each', async () => {
    const { queue, handler, worker } = setUp();
    await queue.enqueue(kind, { n: 1 }, { key: 'a' });
    await queue.enqueue(kind, { n: 2 }, { key: 'b' });
    expect(await worker.drain()).toBe(2);
    expect(handler.ran.map((r) => r.n)).toEqual([1, 2]);
    expect(queue.jobs.map((j) => j.state)).toEqual(['done', 'done']);
    expect(await worker.drain()).toBe(0);
  });

  it('retries a failure, then reports it to `failed` once it failed for good', async () => {
    const { queue, handler, worker } = setUp();
    handler.throwing = true;
    await queue.enqueue(kind, { n: 7 }, { key: 'a' });
    // Two attempts (retryLimit 1), then the failed queue's job.
    expect(await worker.drain()).toBe(3);
    expect(handler.ran.map((r) => r.context.attempt)).toEqual([1, 2]);
    expect(handler.ran.map((r) => r.context.lastAttempt)).toEqual([
      false,
      true,
    ]);
    expect(handler.failedFor).toEqual([7]);
    expect(queue.jobs[0]).toMatchObject({
      state: 'failed',
      messages: ['Error: boom', 'Error: boom'],
    });
  });

  it('never runs a job whose payload its kind refuses, and never again', async () => {
    const { queue, handler, worker } = setUp();
    queue.put(kind.name, { n: 'not a number' });
    expect(await worker.drain()).toBe(1);
    expect(handler.ran).toEqual([]);
    expect(queue.jobs[0]?.state).toBe('cancelled');
  });

  it('stops after DRAIN_LIMIT jobs', async () => {
    const { queue, worker } = setUp();
    for (let n = 0; n <= DRAIN_LIMIT; n++) queue.put(kind.name, { n });
    expect(await worker.drain()).toBe(DRAIN_LIMIT);
  });
});

describe('enqueueing in a transaction', () => {
  it('adds the job when it commits, and none when it rolls back', async () => {
    const { queue } = setUp();
    const unit = new FakeUnitOfWork();
    await expect(
      unit.run(async (tx) => {
        await queue.enqueue(kind, { n: 1 }, { key: 'a', tx });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(queue.jobs).toEqual([]);
    await unit.run((tx) => queue.enqueue(kind, { n: 1 }, { key: 'a', tx }));
    expect(queue.jobs).toHaveLength(1);
    // The same work again while it is open: no second job.
    expect(await queue.enqueue(kind, { n: 1 }, { key: 'a' })).toBeUndefined();
  });

  it('refuses a payload its kind refuses', async () => {
    const { queue } = setUp();
    await expect(
      queue.enqueue(kind, { n: 'x' } as never, { key: 'a' }),
    ).rejects.toThrow();
  });
});

describe('JobWorker on its timer', () => {
  it('polls, runs up to `concurrency` at once, and picks up the rest', async () => {
    vi.useFakeTimers();
    const { queue, handler, worker } = setUp(1_000);
    let release!: () => void;
    handler.block = new Promise((resolve) => (release = resolve));
    for (const n of [1, 2, 3]) queue.put(kind.name, { n });
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler.ran.map((r) => r.n)).toEqual([1, 2]);
    release();
    handler.block = undefined;
    await vi.advanceTimersByTimeAsync(0);
    expect(handler.ran.map((r) => r.n)).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.jobs.map((j) => j.state)).toEqual(['done', 'done', 'done']);
    await worker.beforeApplicationShutdown();
  });

  it('fails an attempt that runs out of time, aborts it, and ignores its late end', async () => {
    vi.useFakeTimers();
    const { queue, handler, worker } = setUp(1_000);
    let release!: () => void;
    handler.block = new Promise((resolve) => (release = resolve));
    queue.put(kind.name, { n: 1 }, { retryLimit: 1 });
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const first = handler.ran[0]?.context;
    await vi.advanceTimersByTimeAsync(kind.timeoutSeconds * 1_000);
    expect(first?.signal.aborted).toBe(true);
    expect(queue.jobs[0]?.messages).toEqual(['The attempt ran out of time.']);
    // Retried; the first attempt's late end settles nothing.
    handler.block = undefined;
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler.ran.map((r) => r.context.attempt)).toEqual([1, 2]);
    expect(queue.jobs[0]?.state).toBe('done');
    await worker.beforeApplicationShutdown();
  });

  it('aborts an attempt whose claim lapsed (cancelled) at its next heartbeat', async () => {
    vi.useFakeTimers();
    const { queue, handler, worker } = setUp(1_000);
    let release!: () => void;
    handler.block = new Promise((resolve) => (release = resolve));
    const job = queue.put(kind.name, { n: 1 });
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(await queue.cancel(kind, job!.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(handler.ran[0]?.context.signal.aborted).toBe(true);
    expect(queue.jobs[0]?.state).toBe('cancelled');
    // A handler that heeds its signal ends; nothing is settled for it.
    release();
    await worker.beforeApplicationShutdown();
    expect(queue.jobs[0]?.state).toBe('cancelled');
  });

  it('on shutdown waits, then hands what still runs back to the queue', async () => {
    vi.useFakeTimers();
    const { queue, handler, worker } = setUp(1_000);
    handler.block = new Promise(() => undefined);
    queue.put(kind.name, { n: 1 });
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = worker.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_WAIT_MS);
    await stopping;
    expect(handler.ran[0]?.context.signal.aborted).toBe(true);
    expect(queue.jobs[0]).toMatchObject({
      state: 'queued',
      retryCount: 0,
      messages: [],
    });
    // Claims nothing more.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(handler.ran).toHaveLength(1);
    expect(await worker.drain()).toBe(0);
  });
});

describe('JobWorker by role (#527)', () => {
  it('claims nothing in the api role, and records no consumer', async () => {
    vi.useFakeTimers();
    const { queue, handler, worker, consumers } = setUp(1_000, 'api');
    queue.put(kind.name, { n: 1 });
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(handler.ran).toEqual([]);
    expect(queue.jobs[0]?.state).toBe('queued');
    expect(worker.consumes).toBe(false);
    await worker.beforeApplicationShutdown();
    expect(consumers.beats).toEqual([]);
    expect(consumers.left).toEqual([]);
  });

  it('a worker beats as a consumer, says when it consumed, and leaves on shutdown', async () => {
    vi.useFakeTimers();
    const { queue, handler, worker, consumers } = setUp(1_000, 'worker');
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(consumers.beats).toHaveLength(1);
    expect(consumers.beats[0]).toMatchObject({
      role: 'worker',
      consumed: false,
      pid: process.pid,
    });
    queue.put(kind.name, { n: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler.ran.map((r) => r.n)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(CONSUMER_BEAT_MS);
    expect(consumers.beats).toHaveLength(2);
    expect(consumers.beats[1]?.consumed).toBe(true);
    expect(consumers.beats[1]?.id).toBe(consumers.beats[0]?.id);
    await vi.advanceTimersByTimeAsync(CONSUMER_BEAT_MS);
    expect(consumers.beats[2]?.consumed).toBe(false);
    await worker.beforeApplicationShutdown();
    expect(consumers.left).toEqual([consumers.beats[0]?.id]);
    await vi.advanceTimersByTimeAsync(CONSUMER_BEAT_MS * 2);
    expect(consumers.beats).toHaveLength(3);
  });
});
