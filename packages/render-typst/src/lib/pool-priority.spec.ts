import {
  closeWorkerPool,
  compilePdfInWorker,
  configureWorkerPool,
  TypstTimeoutError,
  type WorkerOptions,
  type WorkerPriority,
} from './compile.js';

// Runs in its own test file, so it configures a fresh pool: one worker, room to wait.
describe('worker pool priority', () => {
  beforeAll(() => configureWorkerPool({ size: 1, maxQueue: 10 }));
  afterAll(() => closeWorkerPool());

  it('starts a waiting interactive compilation before every waiting background one', async () => {
    const ended: string[] = [];
    const job = (name: string, priority?: WorkerPriority) =>
      compilePdfInWorker(
        { source: `#text("${name}")`, standard: 'none' },
        { timeoutMs: 120_000, ...(priority && { priority }) },
      ).then(() => ended.push(name));
    // The first takes the only worker; the rest wait, in this order.
    const all = [
      job('first'),
      job('bulk-1', 'background'),
      job('bulk-2', 'background'),
      job('reader'),
      job('bulk-3', 'background'),
      job('reader-2', 'interactive'),
    ];
    await Promise.all(all);
    expect(ended).toEqual([
      'first',
      'reader',
      'reader-2',
      'bulk-1',
      'bulk-2',
      'bulk-3',
    ]);
  }, 180_000);

  it('moves a waiting background compilation someone now waits for ahead of the other background ones (#497)', async () => {
    const ended: string[] = [];
    const job = (name: string, options: WorkerOptions = {}) =>
      compilePdfInWorker(
        { source: `#text("${name}")`, standard: 'none' },
        { timeoutMs: 120_000, ...options },
      ).then(() => ended.push(name));
    const raise = new AbortController();
    const all = [
      job('first'),
      job('bulk-1', { priority: 'background' }),
      job('bulk-2', { priority: 'background', raise: raise.signal }),
      job('reader'),
    ];
    // A reader asks for `bulk-2` now: behind the reader already waiting, ahead of `bulk-1`.
    raise.abort();
    await Promise.all(all);
    expect(ended).toEqual(['first', 'reader', 'bulk-2', 'bulk-1']);
  }, 180_000);

  it('counts a background compilation’s deadline from when a worker takes it, and bounds its wait apart (#497)', async () => {
    // Far longer than its deadline: it holds the only worker until then, 10 s.
    const endless =
      '#for i in range(100000) { for j in range(100000) { let x = i * j } }';
    const hold = compilePdfInWorker(
      { source: endless, standard: 'none' },
      { timeoutMs: 10_000 },
    ).catch((error: unknown) => error);
    // Its deadline (6 s) is shorter than its wait: a deadline counting the wait would expire.
    const bulk = compilePdfInWorker(
      { source: '#text("bulk")', standard: 'none' },
      { priority: 'background', timeoutMs: 6_000, waitMs: 60_000 },
    );
    // Its wait bounded at 1 s: refused as waiting (the server busy), not as a slow document.
    const impatient = compilePdfInWorker(
      { source: '#text("late")', standard: 'none' },
      { priority: 'background', timeoutMs: 60_000, waitMs: 1_000 },
    ).catch((error: unknown) => error);
    expect(await impatient).toBeInstanceOf(TypstTimeoutError);
    expect(((await impatient) as TypstTimeoutError).queued).toBe(true);
    expect((await bulk).length).toBeGreaterThan(0);
    expect(await hold).toBeInstanceOf(TypstTimeoutError);
    // Its compilation still has the deadline: a slow document fails as slow.
    const slow = await compilePdfInWorker(
      { source: endless, standard: 'none' },
      { priority: 'background', timeoutMs: 2_000 },
    ).catch((error: unknown) => error);
    expect(slow).toBeInstanceOf(TypstTimeoutError);
    expect((slow as TypstTimeoutError).queued).toBe(false);
  }, 120_000);

  it('treats a background compilation raised before it reached the pool as interactive, deadline and all (#497)', async () => {
    const endless =
      '#for i in range(100000) { for j in range(100000) { let x = i * j } }';
    const raised = new AbortController();
    raised.abort();
    // Its wait (60 s) would leave a running compile with no deadline: its deadline (2 s) holds.
    const slow = await compilePdfInWorker(
      { source: endless, standard: 'none' },
      {
        priority: 'background',
        timeoutMs: 2_000,
        waitMs: 60_000,
        raise: raised.signal,
      },
    ).catch((error: unknown) => error);
    expect(slow).toBeInstanceOf(TypstTimeoutError);
    expect((slow as TypstTimeoutError).queued).toBe(false);
  }, 30_000);
});
