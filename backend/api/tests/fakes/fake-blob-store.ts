import { Readable } from 'node:stream';
import {
  assertSha256,
  blobStoreUnavailable,
  BlobStore,
  checkPutOptions,
  type BlobInfo,
  type BlobPage,
  type PutResult,
  type PutOptions,
  type StoredBlob,
} from '../../src/blobs/core/blob-store.js';
import { digest } from '../../src/blobs/core/digest.js';

const LONG_AGO = new Date(0);

/** `BlobStore` in memory; `down` makes every call fail as an unreachable store does. */
export class FakeBlobStore extends BlobStore {
  readonly blobs = new Map<
    string,
    // No `storedAt` (a test's own): stored long ago.
    { data: Buffer; contentType: string; storedAt?: Date }
  >();
  /** What `storedAt` a put records (now by default); tests move it. */
  now = () => new Date();
  /** How many blobs `list` answers per page. */
  pageSize = 1000;
  down = false;
  /** The hashes puts stored, in order (not the no-ops). */
  readonly created: string[] = [];

  async put(
    data: AsyncIterable<Uint8Array>,
    options: PutOptions,
  ): Promise<PutResult> {
    checkPutOptions(options);
    this.#up();
    const chunks: Uint8Array[] = [];
    const ref = await digest(data, options.maxBytes, (chunk) => {
      chunks.push(chunk);
    });
    if (this.blobs.has(ref.sha256)) return { ...ref, created: false };
    this.blobs.set(ref.sha256, {
      data: Buffer.concat(chunks),
      contentType: options.contentType,
      storedAt: this.now(),
    });
    this.created.push(ref.sha256);
    return { ...ref, created: true };
  }

  async get(sha256: string): Promise<StoredBlob | undefined> {
    const info = await this.head(sha256);
    const blob = this.blobs.get(sha256);
    return info && blob && { ...info, stream: Readable.from([blob.data]) };
  }

  async head(sha256: string): Promise<BlobInfo | undefined> {
    assertSha256(sha256);
    this.#up();
    const blob = this.blobs.get(sha256);
    return (
      blob && {
        sha256,
        size: blob.data.byteLength,
        contentType: blob.contentType,
        storedAt: blob.storedAt ?? LONG_AGO,
      }
    );
  }

  async list(after?: string): Promise<BlobPage> {
    this.#up();
    const hashes = [...this.blobs.keys()]
      .filter((hash) => after === undefined || hash > after)
      .sort();
    const page = hashes.slice(0, this.pageSize);
    const blobs = page.map((sha256) => {
      const blob = this.blobs.get(sha256)!;
      return {
        sha256,
        size: blob.data.byteLength,
        storedAt: blob.storedAt ?? LONG_AGO,
      };
    });
    const last = page.at(-1);
    return hashes.length > page.length && last !== undefined
      ? { blobs, next: last }
      : { blobs };
  }

  async delete(sha256: string): Promise<void> {
    assertSha256(sha256);
    this.#up();
    this.blobs.delete(sha256);
  }

  async ping(): Promise<void> {
    this.#up();
  }

  #up(): void {
    if (this.down) throw blobStoreUnavailable();
  }
}
