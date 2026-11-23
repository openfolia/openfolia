import {
  closeWorkerPool,
  compilePdfInWorker,
  configureWorkerPool,
  TypstBusyError,
  TypstTimeoutError,
  type WorkerOptions,
} from './compile.js';

const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === '%PDF-';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a job once the pool accepts it. With no queue, a job is turned
 * away (rejected at once) while the only worker is busy or still exiting.
 */
async function startWhenFree(
  source: string,
  options: WorkerOptions = {},
): Promise<{ job: Promise<Buffer> }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = compilePdfInWorker({ source }, options);
    const busy = await Promise.race([
      job.then(
        () => false,
        (e: unknown) => {
          if (e instanceof TypstBusyError) return true;
          throw e; // any other early failure is the real cause
        },
      ),
      // A turned-away job is rejected before the next event-loop turn; a
      // job that started takes far longer than one turn.
      new Promise<boolean>((r) => setImmediate(() => r(false))),
    ]);
    // Wrapped: an async function returning a promise would wait for it.
    if (!busy) return { job };
    await sleep(50);
  }
  throw new Error('the pool never became free');
}

// Runs in its own test file, so it configures a fresh pool: one worker, no waiting jobs.
describe('worker pool limits', () => {
  it('rejects timeouts setTimeout cannot honour', async () => {
    for (const timeoutMs of [0, -5, 1.5, Number.NaN, 2 ** 31]) {
      await expect(
        compilePdfInWorker({ source: '' }, { timeoutMs }),
      ).rejects.toThrow(RangeError);
    }
  });

  it('rejects invalid limits', () => {
    expect(() => configureWorkerPool({ size: 0 })).toThrow(RangeError);
    expect(() => configureWorkerPool({ maxQueue: -1 })).toThrow(RangeError);
    expect(() => configureWorkerPool({ jobsPerWorker: 0 })).toThrow(RangeError);
    expect(() => configureWorkerPool({ size: 1.5 })).toThrow(RangeError);
  });

  it(
    'runs jobs on free workers even with no queue, and rejects the rest',
    { timeout: 60_000 },
    async () => {
      configureWorkerPool({ size: 1, maxQueue: 0, jobsPerWorker: 2 });
      expect(() => configureWorkerPool({})).toThrow(/already running/);

      // Several rounds: the worker is retired after every 2 jobs and replaced.
      for (let round = 0; round < 4; round++) {
        // Busy for a while (tens of ms), so the next job finds no free worker.
        const first = await startWhenFree(
          `#set document(title: "T")\n= Round ${round}\n#for i in range(1000) { for j in range(1000) { let x = i * j } }`,
        );
        await expect(
          compilePdfInWorker({ source: '#set document(title: "T")\n= Extra' }),
        ).rejects.toBeInstanceOf(TypstBusyError);
        expect(isPdf(await first.job)).toBe(true);
      }

      // The last round's worker had its 2 jobs and was retired: the pool is free. The timeout
      // runs on a fake clock (#734). On real time, the job's timer starts before the pool
      // forks its worker and its compile time after; on a loaded machine the fork can take
      // more than half of the 50 ms, and the pool then rightly counts the job as one that waited.
      const slow =
        '#for i in range(1500) { for j in range(1500) { let x = i * j } }';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let timedOut: Promise<Buffer>;
      try {
        timedOut = compilePdfInWorker({ source: slow }, { timeoutMs: 50 });
        // Handled at once, so a rejection never goes unhandled while the clock moves.
        timedOut.catch(() => undefined);
        // Started, not queued: its 50 ms are all compiling time.
        vi.advanceTimersByTime(50);
      } finally {
        vi.useRealTimers();
      }
      await expect(timedOut).rejects.toBeInstanceOf(TypstTimeoutError);
      // It was compiling, not waiting: no reason to expect a retry to work.
      await expect(timedOut).rejects.toMatchObject({ queued: false });
      // The killed worker holds the only place until its thread exits; then the pool serves again.
      expect(
        isPdf(
          await (
            await startWhenFree('#set document(title: "T")\n= After timeout')
          ).job,
        ),
      ).toBe(true);
    },
  );
});

afterAll(() => closeWorkerPool());
