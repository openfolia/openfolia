import type { Readable } from 'node:stream';
import { UnavailableError } from '../../base/core/errors.js';

/** What `put` stored: the SHA-256 of the bytes (64 lowercase hex characters) and their length. */
export interface BlobRef {
  sha256: string;
  size: number;
}

/** What `put` did: the blob's reference, and whether this put stored it. */
export interface PutResult extends BlobRef {
  /**
   * True when this put wrote the bytes and nothing was there under the
   * hash; false when a complete copy was there already (a no-op) or a
   * damaged one was replaced (content may refer to it already, so the
   * blob is not this put's to remove again). Two puts of new bytes at
   * once may both say true.
   */
  created: boolean;
}

/** A stored blob's metadata. */
export interface BlobInfo extends BlobRef {
  /** The media type given when it was first stored (`type/subtype`, lowercase). */
  contentType: string;
  /**
   * When the bytes were stored (the object's or file's modification time):
   * what retention's grace period runs from for a blob no upload records.
   */
  storedAt: Date;
}

/** One blob of a listing: its hash, length and when it was stored. */
export interface BlobEntry extends BlobRef {
  storedAt: Date;
}

/** One page of `list`: blobs in hash order, and where the next page starts (absent: the last). */
export interface BlobPage {
  blobs: BlobEntry[];
  /** Pass as `after` for the next page (a cursor of the adapter's, not always a hash); absent when there is none. */
  next?: string;
}

/** A stored blob, ready to read. The caller must consume or destroy `stream`. */
export interface StoredBlob extends BlobInfo {
  stream: Readable;
}

export interface PutOptions {
  /** `type/subtype`, e.g. `image/png`; decided by the caller (sniffed, never a client's claim). */
  contentType: string;
  /** More bytes than this and nothing is stored (`UnprocessableError` `too-large`). */
  maxBytes: number;
}

/**
 * Port: content-addressed storage for binary files (images now; later
 * attachments, downloads and cached PDFs). The key is the SHA-256 of the
 * bytes, computed by the store while it writes, so a key always names
 * exactly its bytes. Git keeps only these hashes (modules refer to an
 * image as `sha256:<hash>`), so a release tag pins its images.
 *
 * Adapters (`repos/`): S3 (any S3-compatible service), the local file
 * system, and an in-memory fake for tests (`tests/fakes/`); one contract
 * test suite runs against all of them (`blob-stores.spec.ts`). Every
 * method that takes a hash refuses one that is not 64 lowercase hex
 * characters. A store that cannot be reached throws `UnavailableError`
 * (`blob-store-unavailable`), never answers "missing".
 */
export abstract class BlobStore {
  /**
   * Stores the bytes of `data` once: writing the same bytes again is a
   * no-op (the first content type stays; two puts of new bytes at once, or
   * the replacement of a damaged copy, keep the last one's). Nothing is visible under the hash
   * until all of it is written and verified, so a reader never sees part of
   * a blob. Throws `UnprocessableError` `too-large` past `maxBytes`, having
   * stored nothing.
   */
  abstract put(
    data: AsyncIterable<Uint8Array>,
    options: PutOptions,
  ): Promise<PutResult>;

  /** The blob, or `undefined` when there is none under this hash. */
  abstract get(sha256: string): Promise<StoredBlob | undefined>;

  /** The blob's metadata without its bytes, or `undefined`. */
  abstract head(sha256: string): Promise<BlobInfo | undefined>;

  async exists(sha256: string): Promise<boolean> {
    return (await this.head(sha256)) !== undefined;
  }

  /**
   * The blobs stored, in hash order, after the cursor `after` (a page's
   * `next`; from the start without it), one page at a time (the adapter decides how many):
   * for finding blobs nothing refers to. Keys that are not a hash (another
   * tool's objects in the bucket) are skipped.
   */
  abstract list(after?: string): Promise<BlobPage>;

  /**
   * Removes the blob (a no-op when there is none). **For deleting unused
   * files only** (`DeleteAssetAction`, and retention later), which must
   * first establish that nothing refers to the hash and that its upload is
   * older than the grace period (README, "Blob store"). Nothing else
   * deletes blobs, but an upload's clean-up of the blob it just stored.
   */
  abstract delete(sha256: string): Promise<void>;

  /** Resolves when the store answers (for readiness); rejects otherwise. */
  abstract ping(): Promise<void>;
}

/** What a store throws when it cannot be reached; the reason goes to the log, not here. */
export function blobStoreUnavailable(): UnavailableError {
  return new UnavailableError(
    'blob-store-unavailable',
    'The blob store does not answer.',
    5,
  );
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Whether `value` is 64 lowercase hex characters. */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

/** Throws for anything but 64 lowercase hex characters, before it reaches a path or a key. */
export function assertSha256(sha256: string): void {
  if (!isSha256(sha256)) {
    throw new TypeError('Not a SHA-256 hash (64 lowercase hex characters).');
  }
}

/** `type/subtype` in RFC 6838's restricted names, no parameters; lowercase. */
const MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

/** Whether `value` is a media type a store keeps (and a header can carry as it is). */
export function isMediaType(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_TYPE.test(value);
}

/** Checks `put`'s options; throws `TypeError` for a caller's mistake. */
export function checkPutOptions(options: PutOptions): void {
  if (!isMediaType(options.contentType)) {
    throw new TypeError(
      'contentType must be a lowercase type/subtype without parameters.',
    );
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new TypeError('maxBytes must be a whole number of bytes.');
  }
}
