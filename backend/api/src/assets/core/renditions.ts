import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { Injectable, Logger } from '@nestjs/common';
import {
  InvalidParameterError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../base/core/unit-of-work.js';
import { BlobStore } from '../../blobs/core/blob-store.js';
import type { Asset } from './actions/get-asset.action.js';
import {
  RENDITION_SOURCE_TYPES,
  RENDITION_TYPE,
  type RenditionWidth,
} from './asset-rendition.js';
import { AssetRenditions } from './asset-renditions.js';
import { AssetUploads } from './asset-uploads.js';
import { ImageResizer } from './image-resizer.js';

const logger = new Logger('Renditions');

/** The settings renditions run with (`CCMS_RENDITION_*`, provided by `AssetsModule`). */
export abstract class RenditionSettings {
  /** How many renditions are made at once in this process. */
  abstract readonly concurrency: number;
  /** The largest source file a rendition is made of, in bytes. */
  abstract readonly maxSourceBytes: number;
}

/** How many requests may wait for a slot per slot; more are 503 `rendition-busy`. */
const WAITING_PER_SLOT = 4;

/** How long a source that could not be made into a rendition is not tried again. */
export const FAILED_KEPT_MS = 10 * 60_000;
/**
 * How long a source whose making timed out is not tried again: shorter
 * than for bytes that do not decode (a busy machine may be the cause),
 * long enough that asking again and again costs no timeout each time.
 */
export const TIMED_OUT_KEPT_MS = 5 * 60_000;
const FAILED_KEPT = 1000;

/** Where the bytes of a rendition's source come from, once the reader may see it. */
export interface RenditionSource {
  readonly sha256: string;
  /** The stored (or, for the old layout, sniffed) media type. */
  readonly contentType: string;
  readonly size: number;
  /** Whether it is in the blob store (else the repository's old layout). */
  readonly stored: boolean;
  /** Its bytes; `undefined` when gone meanwhile. */
  readonly read: () => Promise<Uint8Array | undefined>;
}

/**
 * Renditions of images (#255): a WebP at a width, made on first request
 * and kept in the blob store, recorded by the source's hash and the width
 * (`AssetRenditions`). Callers decide first that the reader may see the
 * source. Bounded: only `RENDITION_SOURCE_TYPES` (else 400
 * `invalid-parameter`), at most `maxSourceBytes` (422 `too-large`), the
 * resizer's own pixel and time limits, one making per source and width at
 * a time (a second request waits for the first), at most `concurrency`
 * makings at once with a short queue (past it 503 `rendition-busy`), and a
 * source that failed is not tried again for `FAILED_KEPT_MS`, one that
 * timed out for `TIMED_OUT_KEPT_MS`.
 */
@Injectable()
export class Renditions {
  readonly #making = new Map<string, Promise<Uint8Array>>();
  readonly #failed = new Map<string, { until: number; error: Error }>();
  readonly #waiting: (() => void)[] = [];
  #running = 0;

  /** The clock for how long a failure is kept; tests set their own. */
  now: () => number = Date.now;

  constructor(
    private readonly blobs: BlobStore,
    private readonly renditions: AssetRenditions,
    private readonly resizer: ImageResizer,
    private readonly uploads: AssetUploads,
    private readonly unit: UnitOfWork,
    private readonly settings: RenditionSettings,
  ) {}

  /** The rendition of `source` at `width`, from the store or made now. */
  async rendition(
    source: RenditionSource,
    width: RenditionWidth,
  ): Promise<Asset> {
    if (
      !(RENDITION_SOURCE_TYPES as readonly string[]).includes(
        source.contentType,
      )
    ) {
      throw new InvalidParameterError(
        'width',
        `A ${source.contentType} file has no renditions; only PNG, JPEG, GIF and WebP images do.`,
      );
    }
    const kept = await this.renditions.find(source.sha256, width);
    if (kept) {
      const stored = await this.blobs.get(kept.sha256);
      if (stored) {
        return {
          stream: stored.stream,
          type: RENDITION_TYPE,
          size: stored.size,
        };
      }
      // Its blob is gone (removed with an earlier source): made again.
    }
    const key = `${source.sha256}:${width}`;
    let making = this.#making.get(key);
    if (!making) {
      making = this.#make(source, width).finally(() =>
        this.#making.delete(key),
      );
      this.#making.set(key, making);
    }
    const bytes = await making;
    return {
      stream: Readable.from([Buffer.from(bytes)]),
      type: RENDITION_TYPE,
      size: bytes.byteLength,
    };
  }

  async #make(
    source: RenditionSource,
    width: RenditionWidth,
  ): Promise<Uint8Array> {
    const failed = this.#failed.get(source.sha256);
    if (failed && failed.until > this.now()) throw failed.error;
    this.#failed.delete(source.sha256);
    if (source.size > this.settings.maxSourceBytes) {
      throw new UnprocessableError(
        'too-large',
        `The image is larger than ${this.settings.maxSourceBytes} bytes; use the original.`,
        { max: this.settings.maxSourceBytes },
      );
    }
    await this.#slot();
    let bytes: Uint8Array;
    try {
      const data = await source.read();
      // Deleted between its head and its read.
      if (data === undefined) throw new NotFoundError('No such file.');
      if (data.byteLength > this.settings.maxSourceBytes) {
        throw new UnprocessableError(
          'too-large',
          `The image is larger than ${this.settings.maxSourceBytes} bytes; use the original.`,
          { max: this.settings.maxSourceBytes },
        );
      }
      try {
        bytes = await this.resizer.toWebp(data, width);
      } catch (error) {
        if (error instanceof UnprocessableError) {
          this.#remember(source.sha256, error, FAILED_KEPT_MS);
        } else if (
          error instanceof UnavailableError &&
          error.code === 'rendition-timeout'
        ) {
          this.#remember(source.sha256, error, TIMED_OUT_KEPT_MS);
        }
        throw error;
      }
    } finally {
      this.#release();
    }
    await this.#keep(source, width, bytes);
    return bytes;
  }

  /** Stores the rendition and records it; a failure only costs making it again later. */
  async #keep(
    source: RenditionSource,
    width: RenditionWidth,
    bytes: Uint8Array,
  ): Promise<void> {
    try {
      const put = await this.blobs.put(Readable.from([Buffer.from(bytes)]), {
        contentType: RENDITION_TYPE,
        maxBytes: bytes.byteLength,
      });
      await this.unit.run(async (tx) => {
        // The source's lock, which deleting it takes: a rendition is never
        // recorded for a source deleted meanwhile.
        await this.uploads.lockHash(tx, source.sha256);
        if (source.stored && !(await this.blobs.exists(source.sha256))) return;
        await this.renditions.record(tx, {
          sourceSha256: source.sha256,
          width,
          sha256: put.sha256,
          size: put.size,
        });
      }, BOUNDED);
    } catch (error) {
      logger.warn(
        `The rendition of ${source.sha256} at ${width} was not kept: ${String(error)}`,
      );
    }
  }

  #remember(sha256: string, error: Error, keptMs: number): void {
    this.#failed.set(sha256, { until: this.now() + keptMs, error });
    if (this.#failed.size > FAILED_KEPT) {
      const oldest = this.#failed.keys().next().value;
      if (oldest !== undefined) this.#failed.delete(oldest);
    }
  }

  async #slot(): Promise<void> {
    if (this.#running < this.settings.concurrency) {
      this.#running++;
      return;
    }
    if (this.#waiting.length >= this.settings.concurrency * WAITING_PER_SLOT) {
      throw new UnavailableError(
        'rendition-busy',
        'Too many renditions are being made; try again shortly.',
        2,
      );
    }
    // Handed over by `#release` with the count unchanged.
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#running--;
  }
}

/** Reads a stored blob whole, refusing one longer than `max` bytes (undefined when gone). */
export async function readBlob(
  blobs: BlobStore,
  sha256: string,
  max: number,
): Promise<Uint8Array | undefined> {
  const stored = await blobs.get(sha256);
  if (!stored) return undefined;
  if (stored.size > max) {
    stored.stream.destroy();
    return undefined;
  }
  const data = await buffer(stored.stream);
  return data.byteLength > max ? undefined : new Uint8Array(data);
}
