import { Injectable } from '@nestjs/common';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BlobStore, isSha256 } from '../../../blobs/core/blob-store.js';
import type { StoredBlob } from '../../../blobs/core/blob-store.js';
import { referencedImages } from '../branding.js';
import { BrandingStore } from '../branding-store.js';

/**
 * An image the branding uses now (#169), for anyone: the logo, mark and
 * icons show before anyone signs in. Only a hash a field of the branding
 * names is served, never another blob (content images stay behind
 * `GET /assets/:hash` and its reading scope): any other hash, malformed or
 * not, is 404, exactly like a missing one. A reader who already holds the
 * bytes (`cached`: its ETag matched) gets null once the image is found still
 * in use, without the blob store being read.
 */
@Injectable()
export class GetBrandingImageAction implements UnguardedAction {
  readonly policy = 'public';

  constructor(
    private readonly store: BrandingStore,
    private readonly blobs: BlobStore,
  ) {}

  async handle({
    sha256,
    cached = false,
  }: {
    sha256: string;
    cached?: boolean;
  }): Promise<StoredBlob | null> {
    const notFound = () =>
      new NotFoundError('The branding uses no image with this hash.');
    if (!isSha256(sha256)) throw notFound();
    const { branding } = await this.store.read();
    if (!referencedImages(branding).has(sha256)) throw notFound();
    // Only what was recorded as a branding image: PNG or WebP, checked from the bytes.
    const image = await this.store.findImage(sha256);
    if (!image) throw notFound();
    if (cached) return null;
    const blob = await this.blobs.get(sha256);
    if (!blob) throw notFound();
    // Served as the type recorded at upload, whatever the store kept first.
    return { ...blob, contentType: image.contentType };
  }
}
