import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ArchivedFiles } from '../../assets/core/archived-files.js';
import { AssetReferences } from '../../assets/core/asset-references.js';
import { AssetUploads } from '../../assets/core/asset-uploads.js';
import { HeldBlobs } from '../../assets/core/held-blobs.js';
import { UnavailableError } from '../../base/core/errors.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../base/core/unit-of-work.js';
import { BlobStore } from '../../blobs/core/blob-store.js';
import { type ImportRecord, ImportSettings } from './import.js';
import { ImportStore } from './import-store.js';

const logger = new Logger('Imports');

/** What `release` does under the hash's lock. */
type Release =
  /** Nothing: the import is gone, being applied or not yet expired. */
  | { readonly kind: 'stay' }
  /** Remove the import, keep the bytes (`heir` now removes them). */
  | { readonly kind: 'keep'; readonly heir?: string }
  /** Remove the import and, unless content refers to them, the bytes. */
  | { readonly kind: 'delete' };

/** The type an import's upload is stored under: its bytes are an importer's to read, never served. */
export const UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * An import's uploaded file in the blob store: stored when the import is,
 * removed when it goes. Content-addressed bytes can be shared, so they are
 * removed only by the import that stored them (`upload.created`), and only
 * while no image or attachment upload (`asset_uploads`) and no other import
 * names them, no `done` release output records them and the branding
 * does not hold them, checked under the hash's advisory lock that recording
 * an asset upload takes too (`AssetUploads.lockHash`), and while no content
 * refers to them (`release`). An import that still names them takes the
 * duty over.
 */
@Injectable()
export class ImportUploads {
  constructor(
    private readonly blobs: BlobStore,
    private readonly assets: AssetUploads,
    private readonly store: ImportStore,
    private readonly unit: UnitOfWork,
    private readonly settings: ImportSettings,
    private readonly references: AssetReferences,
    private readonly archived: ArchivedFiles,
    private readonly held: HeldBlobs,
  ) {}

  /** Stores the bytes; `created` when they were not there before. */
  put(bytes: Uint8Array) {
    return this.blobs.put(Readable.from([Buffer.from(bytes)]), {
      contentType: UPLOAD_CONTENT_TYPE,
      maxBytes: this.settings.maxBytes,
    });
  }

  /**
   * Records `record` in `tx`, under its upload's hash lock, once the bytes
   * are still there (a concurrent removal of the same bytes by another
   * import's end may have taken them: 503 `upload-interrupted`, upload
   * again).
   */
  async insert(tx: Transaction, record: ImportRecord): Promise<void> {
    await this.assets.lockHash(tx, record.upload.sha256);
    if (!(await this.blobs.exists(record.upload.sha256))) {
      throw new UnavailableError(
        'upload-interrupted',
        'The uploaded file was removed while it was recorded; upload it again.',
        1,
      );
    }
    await this.store.insert(tx, record);
  }

  /**
   * Removes `record` (if `remove`; with `before`, only while it is still
   * expired then and not being applied) and, when nothing else names them,
   * the bytes it stored. Bytes content refers to anywhere stay too
   * (`AssetReferences`), by the protocol of deleting an unused file: under
   * the hash's lock they are first marked deleted (`AssetUploads.markDeleted`),
   * so no working copy naming them saves from then on; then where they are
   * used is read; and only then, under the lock again and with everything
   * decided again, is the import removed and are the bytes deleted, the
   * mark cleared again. Each step is one bounded transaction: a failure
   * leaves the import and its bytes, for the next sweep.
   */
  async release(
    record: Pick<ImportRecord, 'id' | 'upload'>,
    { remove, before }: { remove: boolean; before?: Date },
  ): Promise<void> {
    const { sha256 } = record.upload;
    /** Under the hash's lock in `tx`: what becomes of the import and its bytes. */
    const decide = async (tx: Transaction): Promise<Release> => {
      await this.assets.lockHash(tx, sha256);
      let created = record.upload.created;
      if (remove) {
        // Read again under its row lock: still expired, and not being applied.
        const current = await this.store.lock(tx, record.id);
        if (
          !current ||
          (before !== undefined &&
            (current.state === 'applying' || current.expiresAt > before))
        ) {
          return { kind: 'stay' };
        }
        created = current.upload.created;
      }
      const [next] = await this.store.othersWithUpload(tx, sha256, record.id);
      if (next !== undefined) {
        return { kind: 'keep', ...(created && { heir: next }) };
      }
      // Bytes an asset upload records, a done release output records
      // (`ArchivedFiles`, #602) or the branding holds stay, as for a file
      // delete; other imports are asked above.
      if (
        !created ||
        (await this.assets.recorded(tx, sha256)) ||
        (await this.archived.has(tx, sha256)) ||
        (await this.held.holds(tx, sha256, 'branding')) !== null
      ) {
        return { kind: 'keep' };
      }
      return { kind: 'delete' };
    };
    /** The import removed and the bytes kept, the duty handed on. */
    const keep = async (tx: Transaction, release: Release) => {
      if (remove) await this.store.remove(tx, record.id);
      if (release.kind === 'keep' && release.heir !== undefined) {
        await this.store.takeOverUpload(tx, release.heir);
      }
    };

    const marked = await this.unit.run(async (tx) => {
      const release = await decide(tx);
      if (release.kind === 'stay') return undefined;
      if (release.kind === 'keep') {
        await keep(tx, release);
        return undefined;
      }
      // A mark already there (a deletion of the same bytes) is not ours to clear.
      if ((await this.assets.deletedAmong(tx, [sha256])).length > 0) {
        return { ours: false };
      }
      await this.assets.markDeleted(tx, sha256);
      return { ours: true };
    }, BOUNDED);
    if (marked === undefined) return;
    const unmark = async (tx: Transaction) => {
      if (marked.ours) await this.assets.clearDeleted(tx, sha256);
    };
    try {
      // Read only once the mark is in: no working copy naming them saves now.
      // Other imports are decided under the lock (this one is still kept).
      const usedByContent = (
        (await this.references.placesOf([sha256])).get(sha256) ?? []
      ).some((place) => place.in !== 'import');
      await this.unit.run(async (tx) => {
        const release = await decide(tx);
        // Another's mark, cleared meanwhile, may not have kept a working
        // copy from naming the bytes while they were looked for: next sweep.
        if (
          !marked.ours &&
          (await this.assets.deletedAmong(tx, [sha256])).length === 0
        ) {
          return;
        }
        if (release.kind !== 'stay') {
          if (release.kind === 'keep' || usedByContent) {
            await keep(tx, release);
          } else {
            if (remove) await this.store.remove(tx, record.id);
            await this.blobs.delete(sha256);
          }
        }
        await unmark(tx);
      }, BOUNDED);
    } catch (error) {
      if (marked.ours) {
        await this.unit
          .run(async (tx) => {
            await this.assets.lockHash(tx, sha256);
            await unmark(tx);
          }, BOUNDED)
          .catch((cleared: unknown) =>
            logger.warn(
              `The deletion mark of an import's upload ${sha256} could not be cleared: ${String(cleared)}`,
            ),
          );
      }
      throw error;
    }
  }

  /** `release` of bytes stored for an import that was never recorded; best effort, logged. */
  async discard(sha256: string, created: boolean): Promise<void> {
    try {
      await this.release(
        {
          id: '00000000-0000-7000-8000-000000000000',
          upload: { sha256, size: 0, created },
        },
        { remove: false },
      );
    } catch (error) {
      logger.warn(
        `An import's unrecorded upload ${sha256} could not be removed: ${String(error)}`,
      );
    }
  }
}
