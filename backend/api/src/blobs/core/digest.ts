import { createHash } from 'node:crypto';
import { UnprocessableError } from '../../base/core/errors.js';
import type { BlobRef } from './blob-store.js';

/**
 * Reads `data` to its end, hashing and counting it, and hands each chunk to
 * `write` (awaited, so a slow sink holds the source back). Throws
 * `UnprocessableError` `too-large` as soon as more than `maxBytes` came,
 * before that chunk is written. Every adapter's `put` goes through this, so
 * the hash a blob is stored under is always one computed from its bytes.
 */
export async function digest(
  data: AsyncIterable<Uint8Array>,
  maxBytes: number,
  write: (chunk: Uint8Array) => Promise<void> | void,
): Promise<BlobRef> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of data) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('A blob is read as bytes (Uint8Array chunks).');
    }
    size += chunk.byteLength;
    if (size > maxBytes) throw tooLarge(maxBytes);
    hash.update(chunk);
    await write(chunk);
  }
  return { sha256: hash.digest('hex'), size };
}

export function tooLarge(maxBytes: number): UnprocessableError {
  return new UnprocessableError(
    'too-large',
    `The file is larger than ${maxBytes} bytes.`,
    { max: maxBytes },
  );
}
