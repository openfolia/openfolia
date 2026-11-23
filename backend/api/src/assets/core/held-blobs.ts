import type { Transaction } from '../../base/core/unit-of-work.js';

/** Who holds a blob: an import (its uploaded bundle) or the branding (an uploaded image). */
export type BlobHolder = 'import' | 'branding';

/**
 * Port: blobs another component keeps in the store for its own use, which
 * are no file of content: an import's uploaded bundle (#256), for as long
 * as the import is kept, and every image uploaded for the branding (#169),
 * recorded for good. Such a blob is never unused (`AssetReferences` counts
 * it as used `{ in: <its holder> }`), so the media library neither lists
 * nor deletes it; its owner removes it.
 */
export abstract class HeldBlobs {
  /** The blobs held now, each hash once per holder. */
  abstract held(): Promise<{ sha256: string; by: BlobHolder }[]>;

  /**
   * Whether `sha256` is held, read inside `tx`. Under the hash's lock
   * (`AssetUploads.lockHash`), which storing an import and recording a
   * branding image (#623) take too while they check the bytes are still
   * there: so a file deleted under that lock is either seen held here or
   * found gone by its holder (503). The holder,
   * or null when nothing holds it; with `by`, only whether that holder
   * does (an import, deciding about its own bytes, asks about the branding).
   */
  abstract holds(
    tx: Transaction,
    sha256: string,
    by?: BlobHolder,
  ): Promise<BlobHolder | null>;
}
