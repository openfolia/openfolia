import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  blobStoreUnavailable,
  BlobStore,
  isSha256,
} from '../../../blobs/core/blob-store.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import type { RenditionWidth } from '../asset-rendition.js';
import { nameFits } from '../attachment-types.js';
import { readBlob, Renditions, RenditionSettings } from '../renditions.js';
import { sniffImageType } from '../sniff-image-type.js';
import { FONT_MEDIA_TYPES, fontFileFormat } from '../font-file.js';

/** What a page design's file may be served as in place (#555): raster images only, never SVG. */
const DESIGN_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** How many first bytes tell a design file's type (`sniffImageType` reads up to 4 KiB). */
const DESIGN_HEAD_BYTES = 4096;

export interface Asset {
  /** The bytes; the caller must consume or destroy it. */
  stream: Readable;
  /** The stored media type (blob store), or one sniffed from the bytes (Git). */
  type: string;
  size: number;
  /**
   * Set when the file is sent as a download, never shown in place: an
   * attachment, with the file name it is saved under (absent: none known).
   */
  download?: { readonly fileName?: string };
}

/**
 * An image or an attached file by its SHA-256. Only one a module the actor
 * may see refers to (an image or attachment block);
 * any other is not found, exactly as if it did not exist (checked before
 * the store is asked, so the answer does not tell whether it holds it).
 * Streamed from the blob store with its stored type; an image the store
 * does not hold is read from the repository's `assets/<hash>` (the old
 * layout, until it is removed), its type sniffed from its bytes. A file
 * an attachment block the actor may see attaches is a download (`download`),
 * named as the first such block names it, of the names that fit the
 * stored type (`nameFits`: a block cannot relabel an allowed file as
 * `evil.html` or `x.svg`); with none that fits, under no name (the hash).
 * With `width`, its rendition at that width instead (`Renditions`), after
 * the same check, so a rendition is never served where the original is not.
 *
 * A file a page design at the ref names (its logo, fonts, cover image, a region's
 * images: #555) is served to every reader of the ref, as the designs are; a manual's cover
 * image (#394) to every reader of that manual, the same way. Its type is
 * decided by its bytes, whatever it was stored as: a font as its format's
 * (`font/ttf`, `font/otf`, `font/woff`, `font/woff2`, always a download), a PNG,
 * JPEG, GIF or WebP image as that (in place), anything else, an SVG too, as
 * `application/octet-stream`, a download, so nothing a design names ever renders as a
 * document.
 */
@Injectable()
export class GetAssetAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    hash: string;
    width?: RenditionWidth | undefined;
  },
  Asset
> {
  readonly policy = 'content.read';

  constructor(
    private readonly blobs: BlobStore,
    private readonly renditions: Renditions,
    private readonly settings: RenditionSettings,
  ) {
    super();
  }

  protected async run({
    snapshot,
    hash,
    width,
  }: {
    snapshot: ReadableContent;
    hash: string;
    width?: RenditionWidth | undefined;
  }): Promise<Asset> {
    const notFound = () => new NotFoundError(`No asset "${hash}".`);
    const uses = (await snapshot.assetUsage()).get(`sha256:${hash}`);
    if (!uses) {
      // A file a page design names (every reader's), or a manual the reader may see has as its
      // cover image (#394): served typed by its bytes.
      if (
        !(await snapshot.pageDesignAssets()).has(`sha256:${hash}`) &&
        !(await snapshot.manualCoverAssets()).has(`sha256:${hash}`)
      ) {
        throw notFound();
      }
      return this.designFile(snapshot, hash, width, notFound);
    }
    if (width !== undefined) {
      return this.renditions.rendition(
        await this.source(snapshot, hash, notFound),
        width,
      );
    }
    // Attached anywhere the reader may see: always a download, named as
    // the first such attachment names it (by module ID and language) of
    // the names that fit what is stored.
    const names = uses.flatMap((use) => use.fileNames);
    const download = (type: string) => {
      if (names.length === 0) return {};
      const fileName = names.find((name) => nameFits(name, type));
      return { download: fileName === undefined ? {} : { fileName } };
    };
    const stored = isSha256(hash) ? await this.blobs.get(hash) : undefined;
    if (stored) {
      return {
        stream: stored.stream,
        type: stored.contentType,
        size: stored.size,
        ...download(stored.contentType),
      };
    }
    const data = await snapshot.asset(hash);
    if (!data) throw notFound();
    const type = sniffImageType(data);
    return {
      stream: Readable.from([data]),
      type,
      size: data.byteLength,
      ...download(type),
    };
  }

  /** A file only a page design names: typed by its bytes (see the class). */
  private async designFile(
    snapshot: ReadableContent,
    hash: string,
    width: RenditionWidth | undefined,
    notFound: () => Error,
  ): Promise<Asset> {
    const typed = (head: Uint8Array): Asset['type'] => {
      const font = fontFileFormat(head);
      if (font) return FONT_MEDIA_TYPES[font];
      const image = sniffImageType(head);
      return DESIGN_IMAGE_TYPES.has(image) ? image : 'application/octet-stream';
    };
    if (width !== undefined) {
      const source = await this.source(snapshot, hash, notFound, true);
      return this.renditions.rendition(source, width);
    }
    const stored = isSha256(hash) ? await this.blobs.get(hash) : undefined;
    if (stored) {
      const { head, stream } = await peek(stored.stream, DESIGN_HEAD_BYTES);
      const type = typed(head);
      return {
        stream,
        type,
        size: stored.size,
        ...(DESIGN_IMAGE_TYPES.has(type) ? {} : { download: {} }),
      };
    }
    const data = await snapshot.designAsset(hash);
    if (!data) throw notFound();
    const type = typed(data);
    return {
      stream: Readable.from([data]),
      type,
      size: data.byteLength,
      ...(DESIGN_IMAGE_TYPES.has(type) ? {} : { download: {} }),
    };
  }

  /** Where a rendition of `hash` is made from: the blob store, else the old layout. */
  private async source(
    snapshot: ReadableContent,
    hash: string,
    notFound: () => Error,
    design = false,
  ) {
    const max = this.settings.maxSourceBytes;
    const head = isSha256(hash) ? await this.blobs.head(hash) : undefined;
    if (head) {
      return {
        sha256: hash,
        contentType: head.contentType,
        size: head.size,
        stored: true,
        read: () => readBlob(this.blobs, hash, max),
      };
    }
    const data = design
      ? await snapshot.designAsset(hash)
      : await snapshot.asset(hash);
    if (!data) throw notFound();
    return {
      sha256: hash,
      contentType: sniffImageType(data),
      size: data.byteLength,
      stored: false,
      read: async () => data,
    };
  }
}

/**
 * The first `bytes` of `stream` (or all of a shorter one), and a stream of all of it again:
 * what was read first, then the rest, never read twice.
 */
async function peek(
  stream: Readable,
  bytes: number,
): Promise<{ head: Uint8Array; stream: Readable }> {
  const chunks: Buffer[] = [];
  let length = 0;
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  try {
    while (length < bytes) {
      const next = await iterator.next();
      if (next.done) break;
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } catch {
    // A store that fails mid-read does not answer: 503, as for serving.
    stream.destroy();
    throw blobStoreUnavailable();
  }
  const head = Buffer.concat(chunks);
  async function* rest(): AsyncGenerator<Buffer> {
    yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  const again = Readable.from(rest(), { objectMode: false });
  again.on('close', () => stream.destroy());
  return { head: head.subarray(0, bytes), stream: again };
}
