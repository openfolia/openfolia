import { describe, expect, it } from 'vitest';
import { planBatches, poolRows } from './pooling.js';

describe('planBatches', () => {
  it('groups by length, each group under the token budget', () => {
    const lengths = [10, 500, 12, 300, 11, 9000];
    const batches = planBatches(lengths, 1000);
    expect(batches.flat().sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const batch of batches) {
      const longest = Math.max(...batch.map((i) => lengths[i]!));
      if (batch.length > 1)
        expect(batch.length * longest).toBeLessThanOrEqual(1000);
    }
    // The short ones together, the longest alone.
    expect(batches[0]).toEqual(
      [4, 0, 2].sort((a, b) => lengths[a]! - lengths[b]!),
    );
    expect(batches.at(-1)).toEqual([5]);
  });

  it('keeps every text of a short request in one group', () => {
    expect(planBatches([3, 1, 2], 8192)).toEqual([[1, 2, 0]]);
    expect(planBatches([], 8192)).toEqual([]);
  });
});

describe('poolRows', () => {
  it('averages the tokens the mask holds and scales to unit length', () => {
    // 1 row, 3 tokens, 2 dimensions; the third token is padding.
    const data = new Float32Array([3, 0, 0, 4, 100, 100]);
    const [row] = poolRows(data, [1, 3, 2], [[1, 1, 0]], 'mean');
    expect(Array.from(row!)).toEqual([0.6000000238418579, 0.800000011920929]);
  });

  it('takes the first token with cls', () => {
    const data = new Float32Array([0, 2, 5, 5]);
    const [row] = poolRows(data, [1, 2, 2], [[1, 1]], 'cls');
    expect(Array.from(row!)).toEqual([0, 1]);
  });

  it('takes a model output of one vector per text as it is, scaled', () => {
    const data = new Float32Array([0, 3, 4, 0]);
    const rows = poolRows(data, [2, 2], [], 'mean');
    expect(rows.map((r) => Array.from(r))).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it('leaves a zero vector zero and refuses another shape', () => {
    expect(
      Array.from(poolRows(new Float32Array(2), [1, 2], [], 'mean')[0]!),
    ).toEqual([0, 0]);
    expect(() => poolRows(new Float32Array(1), [1], [], 'mean')).toThrow();
  });
});
