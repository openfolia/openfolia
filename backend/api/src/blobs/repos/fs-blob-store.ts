import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  assertSha256,
  blobStoreUnavailable,
  BlobStore,
  checkPutOptions,
  isMediaType,
  isSha256,
  type BlobEntry,
  type BlobInfo,
  type BlobPage,
  type BlobRef,
  type PutResult,
  type PutOptions,
  type StoredBlob,
} from '../core/blob-store.js';
import { digest } from '../core/digest.js';

/**
 * `BlobStore` in a folder of the local file system, for single-machine
 * installs and tests without Docker. Layout under the root:
 *
 * - `<first 2 hex>/<sha256>`: the bytes;
 * - `<first 2 hex>/<sha256>.json`: `{ "contentType" }`;
 * - `tmp/`: uploads being written, on the same file system, so moving one
 *   into place is an atomic rename.
 *
 * A put writes and syncs the bytes to `tmp/`, hashing them, then renames
 * the metadata and then the bytes into place, so a blob is visible only
 * once complete. Paths are built only from checked hashes.
 */

/** How many blobs a listing looks at at once. */
const STATS_AT_ONCE = 32;

export class FsBlobStore extends BlobStore {
  private readonly logger = new Logger('BlobStore');
  private readonly tmp: string;

  constructor(private readonly root: string) {
    super();
    if (!isAbsolute(root)) {
      throw new TypeError('The blob folder must be an absolute path.');
    }
    this.tmp = join(root, 'tmp');
  }

  async put(
    data: AsyncIterable<Uint8Array>,
    options: PutOptions,
  ): Promise<PutResult> {
    checkPutOptions(options);
    const temp = join(this.tmp, randomUUID());
    try {
      await this.#io(() => mkdir(this.tmp, { recursive: true }));
      const file = await this.#io(() => open(temp, 'wx', 0o600));
      let ref: BlobRef;
      try {
        ref = await digest(data, options.maxBytes, async (chunk) => {
          await this.#io(() => file.write(chunk));
        });
        await this.#io(() => file.sync());
      } finally {
        await file.close();
      }
      const existing = await this.head(ref.sha256);
      // A complete copy is there already: a no-op. One of another length
      // (a damaged file) is replaced by these verified bytes.
      if (existing?.size === ref.size) return { ...ref, created: false };
      const path = this.#path(ref.sha256);
      await this.#io(async () => {
        const folder = join(this.root, ref.sha256.slice(0, 2));
        const made = await mkdir(folder, { recursive: true });
        // A folder just made is synced into the root, so it survives too.
        if (made !== undefined) await syncFolder(this.root);
        const meta = `${temp}.json`;
        await writeSynced(
          meta,
          JSON.stringify({ contentType: options.contentType }),
        );
        await rename(meta, `${path}.json`);
        await rename(temp, path);
        // The renames are durable only once their folder is synced.
        await syncFolder(folder);
      });
      // A repaired copy is not new: content may refer to it already.
      return { ...ref, created: existing === undefined };
    } finally {
      // Left over only when the put failed (renamed away otherwise); a
      // folder that cannot be used already made the put fail.
      await rm(temp, { force: true }).catch(() => undefined);
      await rm(`${temp}.json`, { force: true }).catch(() => undefined);
    }
  }

  async get(sha256: string): Promise<StoredBlob | undefined> {
    const info = await this.head(sha256);
    if (!info) return undefined;
    const file = await this.#io(() =>
      open(this.#path(sha256), 'r').catch(missingAsUndefined),
    );
    // Deleted between the two (retention): as if it had not been there.
    if (!file) return undefined;
    // The size of the file opened, not of the one looked at (a damaged copy
    // may have been replaced in between).
    const opened = await this.#io(() => file.stat()).catch(async (error) => {
      await file.close();
      throw error;
    });
    return {
      ...info,
      size: opened.size,
      stream: file.createReadStream(),
    };
  }

  async head(sha256: string): Promise<BlobInfo | undefined> {
    assertSha256(sha256);
    const path = this.#path(sha256);
    const stats = await this.#io(() => stat(path).catch(missingAsUndefined));
    if (!stats) return undefined;
    return {
      sha256,
      size: stats.size,
      contentType: await this.#type(path),
      storedAt: stats.mtime,
    };
  }

  /** One folder (`<first 2 hex>/`) per page, the first after `after`'s own that holds any. */
  async list(after?: string): Promise<BlobPage> {
    if (after !== undefined) assertSha256(after);
    const folders = await this.#io(
      async () => (await readdir(this.root).catch(missingAsUndefined)) ?? [],
    );
    const prefixes = folders
      .filter((name) => /^[0-9a-f]{2}$/.test(name))
      .filter((name) => after === undefined || name >= after.slice(0, 2))
      .sort();
    for (const [n, prefix] of prefixes.entries()) {
      const folder = join(this.root, prefix);
      const names = await this.#io(
        async () => (await readdir(folder).catch(missingAsUndefined)) ?? [],
      );
      const hashes = names
        .filter((name) => isSha256(name) && name.startsWith(prefix))
        .filter((hash) => after === undefined || hash > after)
        .sort();
      const blobs: BlobEntry[] = [];
      // A few at once (#476: one at a time made listing 3,000 blobs take a second).
      for (let start = 0; start < hashes.length; start += STATS_AT_ONCE) {
        const part = hashes.slice(start, start + STATS_AT_ONCE);
        const stats = await this.#io(() =>
          Promise.all(
            part.map((sha256) =>
              stat(join(folder, sha256)).catch(missingAsUndefined),
            ),
          ),
        );
        for (const [n, sha256] of part.entries()) {
          const found = stats[n];
          // Deleted meanwhile: not listed.
          if (found)
            blobs.push({ sha256, size: found.size, storedAt: found.mtime });
        }
      }
      const last = hashes.at(-1);
      if (last === undefined) continue;
      return n < prefixes.length - 1 ? { blobs, next: last } : { blobs };
    }
    return { blobs: [] };
  }

  async delete(sha256: string): Promise<void> {
    assertSha256(sha256);
    const path = this.#path(sha256);
    await this.#io(async () => {
      await rm(path, { force: true });
      await rm(`${path}.json`, { force: true });
    });
  }

  async ping(): Promise<void> {
    await this.#io(async () => {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.R_OK | constants.W_OK);
    });
  }

  #path(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  /**
   * The stored type; a missing or malformed metadata file gives
   * `application/octet-stream`. Any other failure (EIO, EMFILE, EACCES) is
   * `blob-store-unavailable`, never a type made up from it.
   */
  async #type(path: string): Promise<string> {
    const text = await this.#io(() =>
      readFile(`${path}.json`, 'utf8').catch(missingAsUndefined),
    );
    if (text === undefined) return 'application/octet-stream';
    try {
      const meta = JSON.parse(text) as { contentType?: unknown };
      if (isMediaType(meta.contentType)) return meta.contentType;
    } catch {
      // Below.
    }
    return 'application/octet-stream';
  }

  /** Runs file-system work; a failure is logged and becomes `blob-store-unavailable`. */
  async #io<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      this.logger.error(
        `Blob folder: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw blobStoreUnavailable();
    }
  }
}

async function writeSynced(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** fsync of a folder; where the platform cannot open one (Windows), skipped. */
async function syncFolder(path: string): Promise<void> {
  const folder = await open(path, 'r').catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'EPERM') return undefined;
    throw error;
  });
  if (!folder) return;
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

function missingAsUndefined(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
  throw error;
}
