import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  blobStoreUnavailable,
  BlobStore,
} from '../../blobs/core/blob-store.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  FONT_MEDIA_TYPES,
  type FontFacts,
  fontFileFormat,
  inspectFont,
} from './font-file.js';
import { MAX_FONT_BYTES } from './asset-upload.js';
import { imageDimensions, type Dimensions } from './image-dimensions.js';
import { sniffImageType } from './sniff-image-type.js';

/** What a list of images says about one file. */
export interface AssetInfo {
  /** The stored media type (blob store), or one sniffed from the bytes (Git). */
  readonly contentType: string;
  readonly size: number;
  /** As the image's header states it; absent for an SVG or a header not read. */
  readonly dimensions?: Dimensions;
  /**
   * A font's facts (#555): its family, style and the copyright and licence it states. Present
   * for a stored file whose bytes are a well-formed font; its `contentType` is then the font's
   * format's (`font/ttf`, …), whatever type the bytes were stored with.
   */
  readonly font?: FontFacts;
}

/** How much of a file is read for its dimensions; a header past it gives none. */
export const HEADER_BYTES = 256 * 1024;

/** How many files' facts are kept in memory (each a few dozen bytes). */
export const INFOS_KEPT = 20_000;

/** How long "neither store holds it" is kept: an upload may store it meanwhile. */
export const MISSING_KEPT_MS = 60_000;

interface Kept {
  readonly info: AssetInfo | undefined;
  /** When a "missing" answer stops counting (ms since the epoch). */
  readonly until?: number;
}

/**
 * The facts of an image file by its hash: type, size and dimensions. The
 * bytes of a hash never change, so what was read once is kept (at most
 * `INFOS_KEPT`, least recently used dropped). So is what may not be read
 * again on every list: a file neither store holds (for `MISSING_KEPT_MS`,
 * per commit and reading key) and a file of the old layout whose bytes are
 * not its name (per commit and reading key: a commit never changes). It never decides who may see a file:
 * callers ask only for hashes the reader may see (a readable module refers
 * to it, or they uploaded it).
 */
@Injectable()
export class AssetInfoReader {
  readonly #kept = new Map<string, Kept>();
  readonly #logger = new Logger('Assets');

  /** The clock for how long "missing" is kept; tests set their own. */
  now: () => number = Date.now;

  constructor(private readonly blobs: BlobStore) {}

  /**
   * Drops what is kept of `hash` in this process (its blob was deleted):
   * the next read asks the stores again. Entries kept per commit and
   * reading key expire on their own.
   */
  forget(hash: string): void {
    this.#kept.delete(hash);
  }

  /**
   * The facts of `hash` (64 lowercase hex characters): from the blob
   * store, else from the repository's `assets/<hash>` as `snapshot` reads
   * it (the old layout, only for an image a readable module refers to);
   * `undefined` when neither holds it. Reads at most `HEADER_BYTES` of a
   * stored file, but the whole of one stored as a font (`#font`).
   */
  async info(
    snapshot: ReadableContent,
    hash: string,
  ): Promise<AssetInfo | undefined> {
    // What the repository gives depends on who reads it (`snapshot.asset`
    // answers only for an image a module the reader may see refers to), so
    // what it answered is kept per commit and reading key, never shared
    // with a reader who sees otherwise.
    const atCommit = `${snapshot.commit}|${snapshot.readingKey}:${hash}`;
    for (const key of [hash, atCommit]) {
      const kept = this.#kept.get(key);
      if (!kept) continue;
      this.#kept.delete(key);
      if (kept.until !== undefined && kept.until <= this.now()) continue;
      this.#kept.set(key, kept);
      return kept.info;
    }
    const stored = await this.blobs.get(hash);
    if (stored) {
      let head: Uint8Array;
      try {
        head = await readHead(stored.stream);
      } catch (error) {
        // A store that fails mid-read does not answer: 503, as for serving.
        this.#logger.error(
          `Blob ${hash} failed while being read: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw blobStoreUnavailable();
      }
      const font =
        // Only a file stored as a font is read whole: an attachment that
        // happens to start like one is not.
        fontFileFormat(head) === undefined ||
        !stored.contentType?.startsWith('font/')
          ? undefined
          : await this.#font(hash, stored.size);
      return this.#keep(hash, {
        contentType: font ? FONT_MEDIA_TYPES[font.format] : stored.contentType,
        size: stored.size,
        ...(font ? { font } : dimensionsOf(head)),
      });
    }
    const data = await snapshot.asset(hash);
    if (!data) {
      return this.#keep(atCommit, undefined, this.now() + MISSING_KEPT_MS);
    }
    const info = {
      contentType: sniffImageType(data),
      size: data.byteLength,
      ...dimensionsOf(data),
    };
    // A file of the old layout is named by its hash, but nothing made
    // sure the name is right: kept for every commit only when its bytes
    // are that hash, else for this commit only.
    const named = createHash('sha256').update(data).digest('hex') === hash;
    return this.#keep(named ? hash : atCommit, info);
  }

  /**
   * The facts of the stored font `hash` (`inspectFont`), read whole: at most `MAX_FONT_BYTES`
   * (the font upload's largest cap; a larger file is no font a design can use); `undefined` for
   * one that is no well-formed font.
   */
  async #font(hash: string, size: number): Promise<FontFacts | undefined> {
    if (size > MAX_FONT_BYTES) return undefined;
    const stored = await this.blobs.get(hash);
    if (!stored) return undefined;
    const chunks: Uint8Array[] = [];
    let read = 0;
    try {
      for await (const chunk of stored.stream as AsyncIterable<Uint8Array>) {
        read += chunk.byteLength;
        if (read > MAX_FONT_BYTES) return undefined;
        chunks.push(chunk);
      }
    } catch (error) {
      this.#logger.error(
        `Blob ${hash} failed while being read: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw blobStoreUnavailable();
    } finally {
      stored.stream.destroy();
    }
    const inspected = inspectFont(Buffer.concat(chunks));
    return inspected.ok ? inspected.facts : undefined;
  }

  #keep(
    key: string,
    info: AssetInfo | undefined,
    until?: number,
  ): AssetInfo | undefined {
    this.#kept.set(key, until === undefined ? { info } : { info, until });
    if (this.#kept.size > INFOS_KEPT) {
      const oldest = this.#kept.keys().next().value;
      if (oldest !== undefined) this.#kept.delete(oldest);
    }
    return info;
  }
}

const dimensionsOf = (head: Uint8Array): { dimensions?: Dimensions } => {
  const dimensions = imageDimensions(head);
  return dimensions ? { dimensions } : {};
};

/** The first `HEADER_BYTES` of `stream` (or all of a shorter one); the rest is never read. */
async function readHead(
  stream: AsyncIterable<Uint8Array> & { destroy(): void },
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let parsedAt = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= HEADER_BYTES) break;
      // Parsed again only every 16 KiB, so tiny chunks cost no more.
      if (size - parsedAt >= 16 * 1024 || parsedAt === 0) {
        parsedAt = size;
        if (imageDimensions(Buffer.concat(chunks))) break;
      }
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, HEADER_BYTES);
}
