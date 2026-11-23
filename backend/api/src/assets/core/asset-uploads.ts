import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import type { AssetUpload, NewAssetUpload } from './asset-upload.js';

/** Every upload of one hash, across change sets, in one. */
export interface UploadedFile {
  readonly sha256: string;
  /** The latest upload's time, of any change set: the grace period runs from it. */
  readonly lastUploadedAt: Date;
  /** The first upload's type. */
  readonly contentType: string;
  /** The first upload's file name that has one. */
  readonly fileName?: string;
}

/**
 * Port: the record of uploaded images (Postgres), one per change set and
 * hash. The bytes are in the blob store; Git holds only the hash a module
 * refers to.
 */
export abstract class AssetUploads {
  /**
   * Records `upload` inside `tx`, unless this change set holds that hash
   * already: then only its `lastUploadedAt` moves to now, and it is
   * returned with `created` false. Of two transactions recording the same
   * one at once, exactly one creates it.
   */
  abstract record(
    tx: Transaction,
    upload: NewAssetUpload,
  ): Promise<{ upload: AssetUpload; created: boolean }>;

  /**
   * Holds the hash's lock until `tx` ends (an advisory lock): recording an
   * upload of it and removing its unrecorded blob take it, so neither runs
   * between the other's check and write.
   */
  abstract lockHash(tx: Transaction, sha256: string): Promise<void>;

  /**
   * `lockHash` for each of `hashes` at once, in one statement and in hash
   * order (so two transactions never wait for each other in a circle).
   */
  abstract lockHashes(
    tx: Transaction,
    hashes: readonly string[],
  ): Promise<void>;

  /** Whether any change set holds an upload of `sha256`, read inside `tx`. */
  abstract recorded(tx: Transaction, sha256: string): Promise<boolean>;

  /**
   * How many files the change set holds, read inside `tx`; with `topType`,
   * only those whose type is `<topType>/…` (`font`: its fonts).
   */
  abstract count(
    tx: Transaction,
    changeSetId: string,
    topType?: string,
  ): Promise<number>;

  /** The upload of `sha256` into the change set, or `undefined`. */
  abstract find(
    changeSetId: string,
    sha256: string,
  ): Promise<AssetUpload | undefined>;

  /**
   * The images uploaded into the change set, last uploaded first (ties by
   * hash), at most `MAX_UPLOADS_PER_CHANGE_SET` of them.
   */
  abstract list(changeSetId: string): Promise<AssetUpload[]>;

  /** The latest upload's time of `sha256` in any change set, read inside `tx`; undefined for none. */
  abstract lastUploaded(
    tx: Transaction,
    sha256: string,
  ): Promise<Date | undefined>;

  /** Removes every upload record of `sha256` inside `tx`; how many. */
  abstract removeAllOf(tx: Transaction, sha256: string): Promise<number>;

  /** Every hash uploaded into any change set, one entry each (for finding unused files). */
  abstract files(): Promise<UploadedFile[]>;

  /**
   * Which of `hashes` a change set `author` wrote holds an upload of, each
   * once, sorted: files that author may read (the preview of their own
   * uploads, any state), since they sent those very bytes. Another
   * author's uploads never count; a malformed hash is never among them.
   */
  abstract uploadedForAuthor(
    author: ChangeSetAuthor,
    hashes: readonly string[],
  ): Promise<string[]>;

  /** The hashes uploaded into any of `changeSetIds` (a file an open change set holds is used). */
  abstract uploadedInto(changeSetIds: readonly string[]): Promise<string[]>;

  /**
   * Marks `sha256` as deleted inside `tx` (under its lock): from then on a
   * working copy naming it is refused (`deletedAmong`) until an upload of
   * the same bytes clears the mark.
   */
  abstract markDeleted(tx: Transaction, sha256: string): Promise<void>;

  /** Clears the mark of `sha256` inside `tx`. */
  abstract clearDeleted(tx: Transaction, sha256: string): Promise<void>;

  /** Which of `hashes` are marked deleted, read inside `tx`. */
  abstract deletedAmong(
    tx: Transaction,
    hashes: readonly string[],
  ): Promise<string[]>;
}
