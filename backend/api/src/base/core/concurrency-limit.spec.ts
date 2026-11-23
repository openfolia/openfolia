import { ConcurrencyLimit } from './concurrency-limit.js';

class Busy extends Error {}

/** A task that runs until `finish()`. */
function held() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { task: () => done, finish };
}

describe('ConcurrencyLimit', () => {
  afterEach(() => vi.useRealTimers());

  it('runs at most max at once; the next waits and takes the slot a finished one hands it', async () => {
    const limit = new ConcurrencyLimit(2, 1_000, 10, () => new Busy());
    const a = held();
    const b = held();
    const started: string[] = [];
    const first = limit.run(async () => (started.push('a'), a.task()));
    const second = limit.run(async () => (started.push('b'), b.task()));
    const third = limit.run(async () => {
      started.push('c');
      return 'c';
    });
    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);
    expect([limit.running, limit.waiting]).toEqual([2, 1]);
    a.finish();
    await expect(third).resolves.toBe('c');
    expect(started).toEqual(['a', 'b', 'c']);
    b.finish();
    await Promise.all([first, second]);
    expect([limit.running, limit.waiting]).toEqual([0, 0]);
  });

  it('refuses a task that waited longer than waitMs, without running it', async () => {
    vi.useFakeTimers();
    const limit = new ConcurrencyLimit(1, 500, 10, () => new Busy());
    const a = held();
    const first = limit.run(a.task);
    const ran = vi.fn(async () => 'late');
    const waiting = limit.run(ran);
    const refused = expect(waiting).rejects.toBeInstanceOf(Busy);
    await vi.advanceTimersByTimeAsync(499);
    expect(limit.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await refused;
    expect(ran).not.toHaveBeenCalled();
    expect(limit.waiting).toBe(0);
    a.finish();
    await first;
    expect(limit.running).toBe(0);
  });

  it('refuses at once past maxWaiting', async () => {
    const limit = new ConcurrencyLimit(1, 1_000, 1, () => new Busy());
    const a = held();
    const first = limit.run(a.task);
    const second = limit.run(async () => 'second');
    await expect(limit.run(async () => 'third')).rejects.toBeInstanceOf(Busy);
    a.finish();
    await expect(second).resolves.toBe('second');
    await first;
  });

  it('frees the slot when a task fails', async () => {
    const limit = new ConcurrencyLimit(1, 1_000, 1, () => new Busy());
    await expect(
      limit.run(async () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(limit.running).toBe(0);
    await expect(limit.run(async () => 'ok')).resolves.toBe('ok');
  });
});
