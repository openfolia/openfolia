import { describe, expect, it } from 'vitest';
import { mapAtMost } from './map-at-most.js';

describe('mapAtMost', () => {
  it('maps in order, never running more than the limit at once', async () => {
    let running = 0;
    let most = 0;
    const out = await mapAtMost([5, 1, 4, 2, 3], 2, async (n, i) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return `${i}:${n}`;
    });
    expect(out).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3']);
    expect(most).toBe(2);
  });

  it('gives nothing for nothing', async () => {
    expect(await mapAtMost([], 4, async () => 1)).toEqual([]);
  });

  it('rejects with the first failure and starts nothing after it', async () => {
    const started: number[] = [];
    await expect(
      mapAtMost([1, 2, 3, 4], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('two');
        return n;
      }),
    ).rejects.toThrow('two');
    expect(started).toEqual([1, 2]);
  });
});
