import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { UnprocessableError } from '../src/base/core/errors.js';
import type { BlobStore } from '../src/blobs/core/blob-store.js';

const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

/** `data` as a stream of `size`-byte chunks. */
const chunked = (data: Buffer, size = 1000) =>
  Readable.from(
    Array.from({ length: Math.ceil(data.length / size) }, (_, n) =>
      data.subarray(n * size, (n + 1) * size),
    ),
  );

const PNG = { contentType: 'image/png', maxBytes: 10_000_000 };

/**
 * What every `BlobStore` adapter must do, run against each of them
 * (`src/blobs/repos/blob-stores.spec.ts`): the fake, the file system and,
 * when `CCMS_TEST_S3_ENDPOINT` is set, an S3-compatible service.
 */
export function blobStoreContract(make: () => BlobStore): void {
  let store: BlobStore;
  beforeEach(() => {
    store = make();
  });

  it('stores bytes under their SHA-256 and reads them back with their type', async () => {
    const data = randomBytes(25_000);
    const ref = await store.put(chunked(data), PNG);
    expect(ref).toEqual({
      sha256: sha256(data),
      size: data.length,
      created: true,
    });
    expect(await store.exists(ref.sha256)).toBe(true);
    const before = Date.now();
    expect(await store.head(ref.sha256)).toEqual({
      sha256: ref.sha256,
      size: ref.size,
      contentType: 'image/png',
      storedAt: expect.any(Date),
    });
    // Stored just now (a minute either way, for a service's clock).
    const { storedAt } = (await store.head(ref.sha256))!;
    expect(Math.abs(storedAt.getTime() - before)).toBeLessThan(60_000);
    const blob = await store.get(ref.sha256);
    expect(blob).toMatchObject({
      sha256: ref.sha256,
      size: ref.size,
      contentType: 'image/png',
    });
    expect(await buffer(blob!.stream)).toEqual(data);
  });

  it('stores the same bytes once: a second put is a no-op that keeps the first type', async () => {
    const data = randomBytes(2_000);
    const first = await store.put(chunked(data), PNG);
    const second = await store.put(chunked(data, 7), {
      ...PNG,
      contentType: 'image/webp',
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect((await store.head(first.sha256))?.contentType).toBe('image/png');
    expect(await buffer((await store.get(first.sha256))!.stream)).toEqual(data);
  });

  it('stores an empty file, and one of exactly maxBytes', async () => {
    const empty = await store.put(Readable.from([]), PNG);
    expect(empty).toEqual({
      sha256: sha256(Buffer.alloc(0)),
      size: 0,
      created: true,
    });
    expect(await buffer((await store.get(empty.sha256))!.stream)).toEqual(
      Buffer.alloc(0),
    );
    const data = randomBytes(4_096);
    expect(
      (await store.put(chunked(data), { ...PNG, maxBytes: 4_096 })).size,
    ).toBe(4_096);
  });

  it('refuses more than maxBytes and stores nothing', async () => {
    const data = randomBytes(5_000);
    const error = await store
      .put(chunked(data), { ...PNG, maxBytes: 4_999 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnprocessableError);
    expect(error).toMatchObject({ code: 'too-large', meta: { max: 4_999 } });
    expect(await store.exists(sha256(data))).toBe(false);
  });

  it('stores nothing when the source fails', async () => {
    const data = randomBytes(3_000);
    async function* failing() {
      yield data.subarray(0, 1_000);
      throw new Error('connection reset');
    }
    await expect(store.put(failing(), PNG)).rejects.toThrow('connection reset');
    expect(await store.exists(sha256(data.subarray(0, 1_000)))).toBe(false);
  });

  it('answers undefined for a hash it does not hold', async () => {
    const hash = sha256(randomBytes(16));
    expect(await store.head(hash)).toBeUndefined();
    expect(await store.get(hash)).toBeUndefined();
    expect(await store.exists(hash)).toBe(false);
  });

  it('deletes a blob; deleting a missing one is a no-op', async () => {
    const ref = await store.put(chunked(randomBytes(100)), PNG);
    await store.delete(ref.sha256);
    expect(await store.exists(ref.sha256)).toBe(false);
    await expect(store.delete(ref.sha256)).resolves.toBeUndefined();
  });

  it('refuses anything but a SHA-256 hash as a key', async () => {
    for (const bad of [
      '../../etc/passwd',
      'A'.repeat(64),
      'a'.repeat(63),
      `${'a'.repeat(64)}/`,
      '',
    ]) {
      await expect(store.head(bad)).rejects.toThrow(TypeError);
      await expect(store.get(bad)).rejects.toThrow(TypeError);
      await expect(store.delete(bad)).rejects.toThrow(TypeError);
    }
  });

  it('refuses a content type that is not a plain type/subtype', async () => {
    for (const contentType of [
      'image/png; charset=utf-8',
      'IMAGE/PNG',
      'text/html\r\nSet-Cookie: x',
      'png',
    ]) {
      await expect(
        store.put(Readable.from([Buffer.from('x')]), { ...PNG, contentType }),
      ).rejects.toThrow(TypeError);
    }
  });

  it('lists what it holds in hash order, page by page', async () => {
    const stored = await Promise.all(
      [randomBytes(10), randomBytes(20), randomBytes(30)].map((data) =>
        store.put(chunked(data), PNG),
      ),
    );
    const listAll = async () => {
      const all: { sha256: string; size: number; storedAt: Date }[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 10_000; pages++) {
        const page = await store.list(after);
        all.push(...page.blobs);
        if (page.next === undefined) break;
        after = page.next;
      }
      return all;
    };
    const listed = await listAll();
    const hashes = listed.map((blob) => blob.sha256);
    expect(hashes).toEqual([...new Set(hashes)].sort());
    for (const ref of stored) {
      expect(listed.find((blob) => blob.sha256 === ref.sha256)).toEqual({
        sha256: ref.sha256,
        size: ref.size,
        storedAt: expect.any(Date),
      });
    }
    await store.delete(stored[0]!.sha256);
    const again = await listAll();
    expect(again.map((blob) => blob.sha256)).not.toContain(stored[0]!.sha256);
  });

  it('answers a ping', async () => {
    await expect(store.ping()).resolves.toBeUndefined();
  });
}
