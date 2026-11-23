import { z } from 'zod';
import { JobHandlers } from './job-handlers.js';
import { defineJob, JobHandler } from './job.js';

const kind = defineJob({
  name: 'test.render',
  payload: z.strictObject({ id: z.string() }),
  concurrency: 1,
});

class Handler extends JobHandler<{ id: string }> {
  readonly kind = kind;
  constructor(override readonly concurrency?: number) {
    super();
  }
  run(): Promise<void> {
    return Promise.resolve();
  }
}

describe('JobHandlers', () => {
  it('runs as many at once as the handler says, else as its kind says (#497)', () => {
    expect(
      new JobHandlers([new Handler(6)]).queue(kind.name)?.policy,
    ).toMatchObject({
      concurrency: 6,
      retryLimit: kind.retryLimit,
      timeoutSeconds: kind.timeoutSeconds,
    });
    expect(
      new JobHandlers([new Handler()]).queue(kind.name)?.policy.concurrency,
    ).toBe(1);
    // Still the kind's handler.
    expect(new JobHandlers([new Handler(6)]).handles(kind)).toBe(true);
    expect(() => new JobHandlers([new Handler(0)])).toThrow('out of range');
  });
});
