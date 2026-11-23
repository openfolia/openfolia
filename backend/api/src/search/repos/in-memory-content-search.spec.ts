import { Limit } from './in-memory-content-search.js';
import {
  InMemoryContentSearch,
  INDEXES_KEPT,
} from './in-memory-content-search.js';
import { contentSearchContract } from '../../../tests/content-search-contract.js';

contentSearchContract(
  'InMemoryContentSearch',
  () => new InMemoryContentSearch(),
  INDEXES_KEPT,
);

describe('Limit', () => {
  it('never runs more than max at once, in order, and a failing task frees its slot', async () => {
    const limit = new Limit(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (n: number, fail = false) =>
      limit.run(async () => {
        started.push(n);
        peak = Math.max(peak, ++running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        if (fail) throw new Error(`task ${n} failed`);
        return n;
      });
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4, 5].map((n) => task(n, n % 2 === 1)),
    );
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'rejected',
      'fulfilled',
      'rejected',
    ]);
    // Nothing is left held: the next two start at once.
    expect(await Promise.all([task(6), task(7)])).toEqual([6, 7]);
    expect(peak).toBe(2);
  });

  it('frees the slot when the task throws before returning a promise', async () => {
    const limit = new Limit(1);
    await expect(
      limit.run((): Promise<number> => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(await limit.run(() => Promise.resolve(1))).toBe(1);
  });
});
