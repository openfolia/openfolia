import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  AssetRendition,
  NewAssetRendition,
  RenditionWidth,
} from './asset-rendition.js';

/**
 * Port: the record of renditions (Postgres), one per source image and
 * width. The bytes are in the blob store under their own hash.
 */
export abstract class AssetRenditions {
  /** The rendition of `sourceSha256` at `width`, or `undefined`. */
  abstract find(
    sourceSha256: string,
    width: RenditionWidth,
  ): Promise<AssetRendition | undefined>;

  /** Records `rendition` inside `tx`, replacing one of the same source and width. */
  abstract record(tx: Transaction, rendition: NewAssetRendition): Promise<void>;

  /** Removes every rendition of `sourceSha256` inside `tx`; those removed. */
  abstract removeAllOf(
    tx: Transaction,
    sourceSha256: string,
  ): Promise<AssetRendition[]>;

  /** Whether some rendition's bytes are `sha256`, read inside `tx`. */
  abstract isRendition(tx: Transaction, sha256: string): Promise<boolean>;

  /** The hashes of every rendition's bytes (not files of their own: never unused). */
  abstract renditionHashes(): Promise<Set<string>>;
}
