import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * What counts towards the storage an instance uses (#404): `media`, the
 * files uploaded into change sets (images and attachments, every one kept,
 * each stored once by its hash), and `pdfs`, the release outputs archived
 * in the blob store. Not counted: renditions and the render cache (made
 * again on request), an import's uploaded bundle (removed when the import
 * expires), the Git content and the database (reported for information).
 */
export type StorageCategory = 'media' | 'pdfs';

/** How much one category holds. */
export interface CategoryUsage {
  readonly bytes: number;
  readonly files: number;
}

export const NO_USAGE: CategoryUsage = Object.freeze({ bytes: 0, files: 0 });

/** The kept totals, as the last recount and every change since left them. */
export interface StorageTotals {
  readonly media: CategoryUsage;
  readonly pdfs: CategoryUsage;
  /** The size of the content repository on disk, as of the last recount; null: not known. */
  readonly gitBytes: number | null;
  /** The database's size, as of the last recount; null: not known. */
  readonly databaseBytes: number | null;
  /** When the totals were last counted afresh; null: never. */
  readonly recountedAt: Date | null;
}

/** What counts towards a limit: media and archived PDFs. */
export const usedBytes = (totals: StorageTotals): number =>
  totals.media.bytes + totals.pdfs.bytes;

/** What a recount found. */
export interface StorageCount {
  readonly media: CategoryUsage;
  readonly pdfs: CategoryUsage;
  readonly gitBytes: number | null;
  readonly databaseBytes: number | null;
}

/** One uploaded file, for the list of the largest. */
export interface StoredFile {
  readonly sha256: string;
  readonly size: number;
  /** The first upload's type. */
  readonly contentType: string;
  /** The first upload's file name that has one. */
  readonly fileName?: string;
  /** The latest upload's time, of any change set. */
  readonly lastUploadedAt: Date;
}

/**
 * Port: the kept totals (one row in Postgres), moved on every upload and
 * delete in the transaction that makes the change, and replaced by a
 * periodic recount, so no request counts the stores.
 */
export abstract class StorageUsage {
  /** The totals now, read inside `tx`. */
  abstract read(tx: Transaction): Promise<StorageTotals>;

  /**
   * Adds `change` to the category inside `tx` (negative to take away; a
   * total never goes below 0), holding the totals' row until `tx` ends,
   * and answers the totals after it.
   */
  abstract adjust(
    tx: Transaction,
    category: StorageCategory,
    change: CategoryUsage,
  ): Promise<StorageTotals>;

  /**
   * Claims the next recount inside `tx`: true when the last one is at
   * least `everyMs` old (or there was none) and no other claim is younger
   * than `claimMs`, so servers side by side recount once.
   */
  abstract claimRecount(
    tx: Transaction,
    now: Date,
    options: { readonly everyMs: number; readonly claimMs: number },
  ): Promise<boolean>;

  /**
   * Replaces the totals with what a recount found, at `now`, inside `tx`,
   * plus what was added since it was claimed (which its listing may have
   * missed): a change made while it counted is counted at worst twice,
   * never lost. Only while its claim (made at `now`) still holds: a recount
   * whose claim another server took over writes nothing.
   */
  abstract recounted(
    tx: Transaction,
    count: StorageCount,
    now: Date,
  ): Promise<void>;

  /**
   * The limit last recorded (null: none), read inside `tx` holding the
   * totals' row, so two servers starting together compare and record it once.
   */
  abstract lockLimit(tx: Transaction): Promise<number | null>;

  /** Records `limit` as the one in force, inside `tx`. */
  abstract recordLimit(tx: Transaction, limit: number | null): Promise<void>;

  /**
   * Why the blob `sha256` is not counted as media, as the media meter
   * leaves it out: an archived PDF (`pdf`, counted apart), a rendition or an
   * import's bundle (not counted); undefined when it counts as media.
   */
  abstract apartFromMedia(
    tx: Transaction,
    sha256: string,
  ): Promise<MediaExclusion | undefined>;

  /** The uploaded files, largest first (ties by hash), one per hash. */
  abstract largestFiles(page: PageRequest): Promise<Paginated<StoredFile>>;
}

/** Why a blob is left out of the media (`StorageUsage.apartFromMedia`). */
export type MediaExclusion = 'pdf' | 'rendition' | 'bundle';

/** Port: counts the media in the blob store afresh (the recount's). */
export abstract class MediaMeter {
  /** Stops with `signal`'s reason once it aborts (the recount's deadline). */
  abstract measure(signal?: AbortSignal): Promise<CategoryUsage>;
}

/** Port: counts the archived PDFs afresh (the recount's). */
export abstract class PdfArchiveMeter {
  abstract measure(signal?: AbortSignal): Promise<CategoryUsage>;
}

/**
 * Port: the sizes reported for information only, never counted towards a
 * limit. Each is null when it cannot be read cheaply.
 */
export abstract class InstanceSizes {
  /** Stops with `signal`'s reason once it aborts. */
  abstract gitBytes(signal?: AbortSignal): Promise<number | null>;
  abstract databaseBytes(): Promise<number | null>;
}
