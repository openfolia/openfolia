import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { Branding, BrandingImage, StoredBranding } from './branding.js';

/**
 * Port: where the branding and its uploaded images are kept (Postgres,
 * `repos/drizzle-branding-store.ts`; in memory for tests).
 */
export abstract class BrandingStore {
  /** The branding now; the defaults (version 0) before the first change. */
  abstract read(): Promise<StoredBranding>;

  /**
   * The branding, locked for `tx` until it ends, so changes happen one at a
   * time and none is lost; made (with the defaults) when there is none yet.
   */
  abstract lock(tx: Transaction): Promise<StoredBranding>;

  /** Writes `branding` as the next version (`tx` holds the lock). */
  abstract write(tx: Transaction, branding: Branding): Promise<StoredBranding>;

  /** An uploaded image by its hash, or `undefined`. */
  abstract findImage(
    sha256: string,
    tx?: Transaction,
  ): Promise<BrandingImage | undefined>;

  /**
   * How many images count towards the cap (`MAX_BRANDING_IMAGES`): those
   * `inUse` names and those uploaded after `since`; an older unused one
   * is the sweep's to remove (#559).
   */
  abstract countImages(
    counted: { readonly inUse: ReadonlySet<string>; readonly since: Date },
    tx?: Transaction,
  ): Promise<number>;

  /** The images on record, last uploaded first (ties by hash). */
  abstract listImages(page: PageRequest): Promise<Paginated<BrandingImage>>;

  /**
   * Images uploaded at or before `before` that `inUse` does not name,
   * oldest first, at most `limit`: what the sweep removes.
   */
  abstract unusedImages(
    inUse: ReadonlySet<string>,
    before: Date,
    limit: number,
  ): Promise<BrandingImage[]>;

  /**
   * Moves the upload time of `sha256` to now inside `tx` (the same image
   * uploaded again): the sweep's day starts again.
   */
  abstract touchImage(
    tx: Transaction,
    sha256: string,
  ): Promise<BrandingImage | undefined>;

  /** Removes the record of `sha256` inside `tx`; whether there was one. */
  abstract removeImage(tx: Transaction, sha256: string): Promise<boolean>;

  /**
   * Records an uploaded image; the same hash again keeps the first record
   * and answers it with `created: false` (`tx` holds the lock).
   */
  abstract recordImage(
    tx: Transaction,
    image: BrandingImage,
  ): Promise<{ image: BrandingImage; created: boolean }>;
}
