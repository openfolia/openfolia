import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AssetUploads } from '../../../assets/core/asset-uploads.js';
import { imageDimensions } from '../../../assets/core/image-dimensions.js';
import { imageFrames } from '../../../assets/core/image-frames.js';
import { sniffImageType } from '../../../assets/core/sniff-image-type.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { BlobStore } from '../../../blobs/core/blob-store.js';
import {
  StorageLimitReachedError,
  StorageQuota,
} from '../../../storage-usage/core/storage-quota.js';
import {
  type Branding,
  BRANDING_IMAGE_TYPES,
  BRANDING_SUBJECT,
  type BrandingImage,
  type BrandingImageType,
  MAX_BRANDING_IMAGE_BYTES,
  MAX_BRANDING_IMAGE_SIDE,
  MAX_BRANDING_IMAGES,
  referencedImages,
  UNUSED_BRANDING_IMAGE_MS,
} from '../branding.js';
import { BrandingStore } from '../branding-store.js';

export interface UploadBrandingImageInput {
  readonly actor: Actor;
  /**
   * The file's bytes. Called only once the actor may upload, so a refused
   * request is never read; at most `MAX_BRANDING_IMAGE_BYTES` + 1 bytes are
   * taken from it.
   */
  readonly file: () => AsyncIterable<Uint8Array>;
}

const tooMany = () =>
  new ConflictError(
    'too-many-uploads',
    `The branding keeps at most ${MAX_BRANDING_IMAGES} images in use or uploaded within a day; delete unused ones (DELETE /branding/images/{hash}).`,
    { max: MAX_BRANDING_IMAGES },
  );

/** What counts towards the cap at `now`: the images `branding` names and the recent ones. */
const countedAt = (branding: Branding, now: number) => ({
  inUse: referencedImages(branding),
  since: new Date(now - UNUSED_BRANDING_IMAGE_MS),
});

/**
 * Uploads an image for the branding (#169): a logo, the mark or an icon.
 * The type comes from the bytes, never from the form: PNG or WebP. SVG is
 * refused, not sanitised, as for content images: an SVG is a document that
 * can carry scripts and references, and a PNG export covers a logo. At most
 * 1 MiB and 4096 pixels a side, and one still picture: an animated PNG or
 * WebP is refused (422 `animated-image`), as the pixel cap holds per frame,
 * and a file not well formed up to its end (`imageFrames`) is no PNG or
 * WebP. Counted towards the storage limit (`StorageQuota`) as a content
 * file is, once per hash: past it 409 `storage-limit-reached`, audited
 * (`storage.upload-refused`, `target: "branding"`). Stored in the blob store under its hash and
 * recorded, with a `branding.image-upload` audit event; it shows nowhere
 * until `PATCH /branding` puts its hash in a field. The same image again is
 * the first record (`created: false`), with nothing new stored or audited.
 * Recorded under the file's hash lock (`AssetUploads.lockHash`), which every
 * blob delete takes while it checks what holds the bytes (`HeldBlobs`), once
 * the blob is still there: a clean-up of the same bytes that removed them
 * meanwhile is 503 `upload-interrupted`, upload again (#623).
 * Needs `admin.branding`.
 */
@Injectable()
export class UploadBrandingImageAction extends ActorAction<
  UploadBrandingImageInput,
  { image: BrandingImage; created: boolean }
> {
  readonly policy = 'admin.branding';

  constructor(
    private readonly store: BrandingStore,
    private readonly blobs: BlobStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly uploads: AssetUploads,
    private readonly quota: StorageQuota,
  ) {
    super();
  }

  /** The clock for the cap's day; tests set their own. */
  now: () => number = Date.now;

  protected async run(input: UploadBrandingImageInput): Promise<{
    image: BrandingImage;
    created: boolean;
  }> {
    try {
      return await this.upload(input);
    } catch (error) {
      // Audited apart: the upload's own transaction rolled back.
      if (error instanceof StorageLimitReachedError) {
        await this.quota.refused(input.actor, error, { target: 'branding' });
      }
      throw error;
    }
  }

  private async upload({ actor, file }: UploadBrandingImageInput): Promise<{
    image: BrandingImage;
    created: boolean;
  }> {
    // A full record, or no room left, refuses before a byte is read.
    const { branding } = await this.store.read();
    if (
      (await this.store.countImages(countedAt(branding, this.now()))) >=
      MAX_BRANDING_IMAGES
    ) {
      throw tooMany();
    }
    const room = await this.quota.room();
    const bytes = await readAll(file(), MAX_BRANDING_IMAGE_BYTES);
    const sniffed = sniffImageType(bytes);
    if (!(BRANDING_IMAGE_TYPES as readonly string[]).includes(sniffed)) {
      throw new UnprocessableError(
        'unsupported-image-type',
        sniffed === 'image/svg+xml'
          ? 'SVG is not taken for the branding: upload a PNG or WebP export.'
          : 'A branding image is a PNG or a WebP.',
        { accepted: BRANDING_IMAGE_TYPES },
      );
    }
    const contentType = sniffed as BrandingImageType;
    const size = imageDimensions(bytes);
    if (!size) {
      throw new UnprocessableError(
        'unsupported-image-type',
        'The image’s size cannot be read from its header.',
        { accepted: BRANDING_IMAGE_TYPES },
      );
    }
    if (
      size.width > MAX_BRANDING_IMAGE_SIDE ||
      size.height > MAX_BRANDING_IMAGE_SIDE
    ) {
      throw new UnprocessableError(
        'image-too-large',
        `A branding image is at most ${MAX_BRANDING_IMAGE_SIDE} pixels wide and high.`,
        { maxSide: MAX_BRANDING_IMAGE_SIDE, ...size },
      );
    }
    const frames = imageFrames(bytes);
    if (frames === 'animated') {
      throw new UnprocessableError(
        'animated-image',
        'A branding image is one still picture: an animated PNG or WebP is not taken.',
        { accepted: BRANDING_IMAGE_TYPES },
      );
    }
    if (frames === 'malformed') {
      throw new UnprocessableError(
        'unsupported-image-type',
        'The image is not a well-formed PNG or WebP up to its end.',
        { accepted: BRANDING_IMAGE_TYPES },
      );
    }
    // No room for these bytes: refused before they are stored (the
    // recording transaction checks again, holding the totals' row).
    const limit = this.quota.limit;
    if (room !== undefined && limit !== null && bytes.byteLength > room) {
      throw new StorageLimitReachedError(limit, limit - room);
    }
    const stored = await this.blobs.put(once(bytes), {
      contentType,
      maxBytes: MAX_BRANDING_IMAGE_BYTES,
    });
    // A refusal from here on (the record filled up meanwhile, the storage
    // limit, the database timed out, the bytes were removed meanwhile)
    // leaves the blob unrecorded: shown nowhere, since only a hash the
    // branding names is served (`GetBrandingImageAction`), and removed
    // again when this upload stored it and nothing took it on meanwhile.
    try {
      return await this.record(actor, stored, contentType, size);
    } catch (error) {
      if (stored.created) await this.removeUnrecorded(stored.sha256);
      throw error;
    }
  }

  private record(
    actor: Actor,
    stored: { readonly sha256: string; readonly size: number },
    contentType: BrandingImageType,
    size: { readonly width: number; readonly height: number },
  ): Promise<{ image: BrandingImage; created: boolean }> {
    return this.unit.run(async (tx) => {
      const current = await this.store.lock(tx);
      // Then the file's hash lock, the only one taken here (lock order: a
      // row lock first, then hash locks in hash order, as an asset upload
      // takes its change set's row and then its hash; nothing holding a
      // hash lock waits for the branding's row). A blob delete checks under
      // it whether the branding holds the bytes: so it either sees this
      // record or is seen here, the blob gone.
      await this.uploads.lockHash(tx, stored.sha256);
      if (!(await this.blobs.exists(stored.sha256))) {
        throw new UnavailableError(
          'upload-interrupted',
          'The image was removed while it was recorded; upload it again.',
          1,
        );
      }
      const existing = await this.store.findImage(stored.sha256, tx);
      if (existing) {
        // Uploaded again: kept another day, as a content file uploaded again is.
        const touched = await this.store.touchImage(tx, stored.sha256);
        return { image: touched ?? existing, created: false };
      }
      if (
        (await this.store.countImages(
          countedAt(current.branding, this.now()),
          tx,
        )) >= MAX_BRANDING_IMAGES
      ) {
        throw tooMany();
      }
      // Bytes no content upload records count towards the storage used
      // (and its limit), decided under the hash's lock as a content
      // upload's first record decides it: one of them counts the bytes,
      // and a content upload of them later counts nothing while the
      // branding holds them (`UploadAssetAction`).
      const counted = await this.uploads.recorded(tx, stored.sha256);
      const recorded = await this.store.recordImage(tx, {
        sha256: stored.sha256,
        contentType,
        size: stored.size,
        width: size.width,
        height: size.height,
        uploadedBy: { kind: actor.kind, id: actor.id },
        uploadedAt: new Date(),
      });
      if (recorded.created && !counted) {
        await this.quota.addMedia(tx, stored.sha256, stored.size);
      }
      if (recorded.created) {
        await this.auditLog.record(tx, actor, {
          action: 'branding.image-upload',
          subject: BRANDING_SUBJECT,
          data: {
            sha256: stored.sha256,
            contentType,
            size: stored.size,
            width: size.width,
            height: size.height,
          },
        });
      }
      return recorded;
    }, BOUNDED);
  }

  /**
   * Removes the blob `sha256` this upload stored and could not record,
   * under the hash's lock, unless something took the same bytes on
   * meanwhile: a content upload, the branding (another upload of them),
   * an import's bundle, a rendition or a release's archived PDF
   * (`StorageQuota.apartFromMedia`). Best effort: a failure is logged and
   * left to the media library, which deletes unused files.
   */
  private async removeUnrecorded(sha256: string): Promise<void> {
    try {
      await this.unit.run(async (tx) => {
        await this.uploads.lockHash(tx, sha256);
        if (
          (await this.uploads.recorded(tx, sha256)) ||
          (await this.store.findImage(sha256, tx)) !== undefined ||
          (await this.quota.apartFromMedia(tx, sha256)) !== undefined
        ) {
          return;
        }
        await this.blobs.delete(sha256);
      }, BOUNDED);
    } catch (error) {
      logger.warn(
        `An unrecorded branding image ${sha256} could not be removed: ${String(error)}`,
      );
    }
  }
}

const logger = new Logger('Branding');

/** All of `data`, refused (422 `too-large`) past `maxBytes`, reading no further. */
async function readAll(
  data: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of data) {
    length += chunk.byteLength;
    if (length > maxBytes) {
      throw new UnprocessableError(
        'too-large',
        `A branding image is at most ${maxBytes} bytes.`,
        { max: maxBytes },
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}
