/**
 * The most tokens one model run holds (texts × the longest of them): the
 * texts of a request are run in groups of about the same length under it,
 * so a request of long texts never needs the memory of 32 at once (a
 * transformer's attention grows with the square of the length).
 */
export const MAX_BATCH_TOKENS = 8_192;

/**
 * The texts' positions, grouped for model runs: sorted by length (so
 * little padding is run), each group's count × its longest at most
 * `maxBatchTokens` (a text longer than that alone in its group).
 */
export function planBatches(
  lengths: readonly number[],
  maxBatchTokens: number = MAX_BATCH_TOKENS,
): number[][] {
  const order = lengths
    .map((length, index) => ({ length, index }))
    .sort((a, b) => a.length - b.length || a.index - b.index);
  const batches: number[][] = [];
  let current: number[] = [];
  for (const { length, index } of order) {
    // Sorted ascending, so this text is the group's longest.
    if (current.length > 0 && (current.length + 1) * length > maxBatchTokens) {
      batches.push(current);
      current = [];
    }
    current.push(index);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * One vector per row of a model's output: `[rows, dimensions]` as it is,
 * `[rows, tokens, dimensions]` pooled (`mean` over the tokens the mask
 * holds, or `cls`, the first), each scaled to unit length (a zero vector
 * stays zero).
 */
export function poolRows(
  data: Float32Array,
  dims: readonly number[],
  mask: readonly (readonly number[])[],
  pooling: 'mean' | 'cls',
): Float32Array[] {
  const rows: Float32Array[] = [];
  if (dims.length === 2) {
    const [count, width] = dims as [number, number];
    for (let r = 0; r < count; r++) {
      rows.push(unit(data.slice(r * width, (r + 1) * width)));
    }
    return rows;
  }
  if (dims.length !== 3) {
    throw new Error(`a model output of ${dims.length} dimensions`);
  }
  const [count, tokens, width] = dims as [number, number, number];
  for (let r = 0; r < count; r++) {
    const row = new Float32Array(width);
    const base = r * tokens * width;
    if (pooling === 'cls') {
      row.set(data.subarray(base, base + width));
    } else {
      const rowMask = mask[r] ?? [];
      let counted = 0;
      for (let t = 0; t < tokens; t++) {
        if (!rowMask[t]) continue;
        counted++;
        const at = base + t * width;
        for (let d = 0; d < width; d++)
          row[d] = (row[d] ?? 0) + (data[at + d] ?? 0);
      }
      if (counted > 0)
        for (let d = 0; d < width; d++) row[d] = (row[d] ?? 0) / counted;
    }
    rows.push(unit(row));
  }
  return rows;
}

/** `vector` scaled to length 1, in place; a zero vector as it is. */
function unit(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const n of vector) sum += n * n;
  const length = Math.sqrt(sum);
  if (length > 0)
    for (let d = 0; d < vector.length; d++)
      vector[d] = (vector[d] ?? 0) / length;
  return vector;
}
