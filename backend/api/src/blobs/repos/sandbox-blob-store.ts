import type { Sandbox } from '../../sandbox/core/sandbox.js';
import {
  BlobStore,
  type BlobInfo,
  type BlobPage,
  type PutOptions,
  type PutResult,
  type StoredBlob,
} from '../core/blob-store.js';

/**
 * A public sandbox's blob store (#826): the instance's own, with every byte put spent against
 * the sandbox's write budget (`Sandbox.spend`) as it streams in, so release files, offline
 * packages and renditions cannot fill the disk. Past the budget the put fails with 422
 * `sandbox-limit-reached` and, like any failed put, stores nothing.
 */
export class SandboxBlobStore extends BlobStore {
  constructor(
    private readonly store: BlobStore,
    private readonly sandbox: Sandbox,
  ) {
    super();
  }

  put(
    data: AsyncIterable<Uint8Array>,
    options: PutOptions,
  ): Promise<PutResult> {
    const sandbox = this.sandbox;
    async function* spent(): AsyncIterable<Uint8Array> {
      for await (const chunk of data) {
        sandbox.spend(chunk.byteLength);
        yield chunk;
      }
    }
    return this.store.put(spent(), options);
  }

  get(sha256: string): Promise<StoredBlob | undefined> {
    return this.store.get(sha256);
  }

  head(sha256: string): Promise<BlobInfo | undefined> {
    return this.store.head(sha256);
  }

  list(after?: string): Promise<BlobPage> {
    return this.store.list(after);
  }

  delete(sha256: string): Promise<void> {
    return this.store.delete(sha256);
  }

  ping(): Promise<void> {
    return this.store.ping();
  }
}
