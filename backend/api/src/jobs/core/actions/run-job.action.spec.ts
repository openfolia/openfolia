import { z } from 'zod';
import type { ClaimedJob } from '../job-claims.js';
import { failedQueueOf, JobHandlers } from '../job-handlers.js';
import { defineJob, type JobContext, JobHandler } from '../job.js';
import {
  failureMessage,
  MAX_FAILURE_MESSAGE,
  RunJobAction,
} from './run-job.action.js';

const kind = defineJob({
  name: 'test.render',
  payload: z.strictObject({ outputId: z.string().min(1) }),
  retryLimit: 2,
});

class RenderHandler extends JobHandler<{ outputId: string }> {
  readonly kind = kind;
  readonly runs: [string, JobContext][] = [];
  readonly failures: string[] = [];
  fail?: Error;

  async run(payload: { outputId: string }, context: JobContext) {
    this.runs.push([payload.outputId, context]);
    if (this.fail) throw this.fail;
  }

  override async failed(payload: { outputId: string }) {
    this.failures.push(payload.outputId);
  }
}

const job = (overrides: Partial<ClaimedJob> = {}): ClaimedJob => ({
  queue: kind.name,
  id: '00000000-0000-4000-8000-000000000001',
  retryCount: 0,
  retryLimit: 2,
  payload: { outputId: 'out-1' },
  ...overrides,
});

describe('defineJob', () => {
  it('fills in the defaults and freezes the kind', () => {
    expect(kind).toMatchObject({
      name: 'test.render',
      retryLimit: 2,
      retryDelaySeconds: 10,
      timeoutSeconds: 900,
      concurrency: 1,
    });
    expect(Object.isFrozen(kind)).toBe(true);
  });

  it('refuses a name that is no kind name, and settings out of range', () => {
    const payload = z.object({});
    for (const name of ['', 'Upper', 'a/b', 'a..b', 'a b', '.a']) {
      expect(() => defineJob({ name, payload })).toThrow('Not a job kind');
    }
    expect(() => defineJob({ name: 'a', payload, retryLimit: -1 })).toThrow();
    expect(() => defineJob({ name: 'a', payload, concurrency: 0 })).toThrow();
    expect(() =>
      defineJob({ name: 'a', payload, timeoutSeconds: 1.5 }),
    ).toThrow();
  });
});

describe('JobHandlers', () => {
  it('lists the kind’s queue and, with `failed`, the failed queue after it', () => {
    const handler = new RenderHandler();
    const handlers = new JobHandlers([handler]);
    expect(
      handlers.queues.map((q) => [q.name, q.phase, q.failedQueue]),
    ).toEqual([
      ['test.render', 'run', 'test.render/failed'],
      ['test.render/failed', 'failed', undefined],
    ]);
    expect(handlers.handles(kind)).toBe(true);
    // Another kind of the same name is not this one.
    expect(handlers.handles(defineJob({ ...kind }))).toBe(false);
  });

  it('refuses two handlers for one kind, and loading twice', () => {
    expect(
      () => new JobHandlers([new RenderHandler(), new RenderHandler()]),
    ).toThrow('Two job handlers');
    const handlers = new JobHandlers([]);
    expect(() => handlers.load([])).toThrow('loaded already');
  });
});

describe('RunJobAction', () => {
  let handler: RenderHandler;
  let action: RunJobAction;
  const signal = new AbortController().signal;
  beforeEach(() => {
    handler = new RenderHandler();
    action = new RunJobAction(new JobHandlers([handler]));
  });

  it('runs the handler with the parsed payload and the attempt', async () => {
    expect(await action.handle(job({ retryCount: 1 }), signal)).toEqual({
      outcome: 'done',
    });
    expect(handler.runs).toEqual([
      [
        'out-1',
        {
          id: job().id,
          attempt: 2,
          lastAttempt: false,
          signal,
        },
      ],
    ]);
    await action.handle(job({ retryCount: 2 }), signal);
    expect(handler.runs[1]?.[1].lastAttempt).toBe(true);
  });

  it('reports a failure with the error’s name and message only, bounded', async () => {
    handler.fail = Object.assign(new TypeError('no such output'), {
      secret: 'x',
    });
    expect(await action.handle(job(), signal)).toEqual({
      outcome: 'failed',
      message: 'TypeError: no such output',
    });
    const long = failureMessage(new Error('x'.repeat(5_000)));
    expect(long).toHaveLength(MAX_FAILURE_MESSAGE);
    expect(failureMessage('plain')).toBe('Thrown: plain');
  });

  it('never hands the handler a payload its kind refuses', async () => {
    for (const payload of [
      null,
      'text',
      {},
      { outputId: '' },
      { outputId: 'a', extra: true },
    ]) {
      expect(await action.handle(job({ payload }), signal)).toEqual({
        outcome: 'refused',
        reason: 'payload',
      });
    }
    expect(handler.runs).toEqual([]);
  });

  it('refuses a job of a queue no handler runs', async () => {
    expect(await action.handle(job({ queue: 'other' }), signal)).toEqual({
      outcome: 'refused',
      reason: 'no-handler',
    });
  });

  it('reports a job that failed for good to `failed`, not `run`', async () => {
    expect(
      await action.handle(job({ queue: failedQueueOf(kind.name) }), signal),
    ).toEqual({ outcome: 'done' });
    expect(handler.failures).toEqual(['out-1']);
    expect(handler.runs).toEqual([]);
  });
});
