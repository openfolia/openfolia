import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { AssetReferences } from '../../assets/core/asset-references.js';
import { AssetUploads } from '../../assets/core/asset-uploads.js';
import { AuditLog } from '../../audit/core/audit-log.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../base/core/unit-of-work.js';
import { BlobStore } from '../../blobs/core/blob-store.js';
import { StorageQuota } from '../../storage-usage/core/storage-quota.js';
import {
  BRANDING_SUBJECT,
  type BrandingImage,
  fieldsNaming,
  type ImageSlot,
} from './branding.js';
import { BrandingStore } from './branding-store.js';

const logger = new Logger('Branding');

/** What became of an image `BrandingImageRemoval.remove` was asked to remove. */
export type Removal =
  /** Removed: its record, and its bytes unless `fileKept`. */
  | { readonly kind: 'removed'; readonly fileKept: boolean }
  /** No record of it (never uploaded, or removed already). */
  | { readonly kind: 'gone' }
  /** A field of the branding names it: kept. */
  | { readonly kind: 'in-use'; readonly usedIn: readonly ImageSlot[] }
  /** Uploaded after `before`: kept (the sweep's grace period). */
  | { readonly kind: 'recent' }
  /** Another deletion of the same bytes is under way (their mark is set): nothing changed, try again. */
  | { readonly kind: 'busy' };

/** What is decided under the branding's row lock and the hash's lock. */
type Decision =
  | Exclude<Removal, { kind: 'removed' }>
  | {
      readonly kind: 'remove';
      readonly image: BrandingImage;
      /** Something else keeps the bytes: a content upload, or they are no media (`apartFromMedia`). */
      readonly keepBytes: boolean;
    };

/**
 * Removes an image uploaded for the branding that no field names (#559):
 * its record, audited (`branding.image-delete`), and its bytes unless
 * something else keeps them. Bytes stay while a content upload records
 * them (`AssetUploads`, it counts them in the storage used then), while
 * they are an import's bundle, a rendition or a release's archived PDF
 * (`StorageQuota.apartFromMedia`), and while content refers to them
 * anywhere (`AssetReferences`: a module or page design at any ref, an open
 * change set, a working copy), by the protocol of deleting an unused
 * file (`DeleteAssetAction`) and an import's upload (`ImportUploads`):
 * under the branding's row lock and the hash's lock it is first checked
 * and the bytes marked deleted (`AssetUploads.markDeleted`), so no working
 * copy naming them saves from then on; then where they are used is read;
 * and only then, under both locks again and with everything decided
 * again, is the record removed, the bytes deleted or kept, and the mark
 * cleared. A `PATCH /branding` naming it meanwhile is seen there (it takes
 * the row lock and needs the record), and so is an upload of the same
 * bytes, for the branding or into a change set (the hash's lock). Each step
 * is one bounded transaction; a failure leaves the image as it was.
 * Removing the bytes takes them off the storage used, which the branding's
 * upload counted (`UploadBrandingImageAction`).
 */
@Injectable()
export class BrandingImageRemoval {
  constructor(
    private readonly store: BrandingStore,
    private readonly uploads: AssetUploads,
    private readonly references: AssetReferences,
    private readonly blobs: BlobStore,
    private readonly quota: StorageQuota,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  /** Removes the image `sha256` as `actor`; with `before`, only one uploaded at or before it. */
  async remove(
    actor: Actor,
    sha256: string,
    { before }: { readonly before?: Date } = {},
  ): Promise<Removal> {
    const decide = async (tx: Transaction): Promise<Decision> => {
      // The row lock first, then the hash's, as an upload takes them.
      const { branding } = await this.store.lock(tx);
      await this.uploads.lockHash(tx, sha256);
      const image = await this.store.findImage(sha256, tx);
      if (!image) return { kind: 'gone' };
      const usedIn = fieldsNaming(branding, sha256);
      if (usedIn.length > 0) return { kind: 'in-use', usedIn };
      if (before !== undefined && image.uploadedAt > before) {
        return { kind: 'recent' };
      }
      const keepBytes =
        (await this.uploads.recorded(tx, sha256)) ||
        (await this.quota.apartFromMedia(tx, sha256)) !== undefined;
      return { kind: 'remove', image, keepBytes };
    };

    const first = await this.unit.run<
      { readonly done: Removal } | { readonly ours: boolean }
    >(async (tx) => {
      const decision = await decide(tx);
      if (decision.kind !== 'remove') return { done: decision };
      if (decision.keepBytes) {
        return { done: await this.#removeRecord(tx, actor, decision, true) };
      }
      // A mark already there (a deletion of the same bytes under way) is
      // not ours: nothing proceeds under it, try again once it ended.
      if ((await this.uploads.deletedAmong(tx, [sha256])).length > 0) {
        return { done: { kind: 'busy' } };
      }
      await this.uploads.markDeleted(tx, sha256);
      return { ours: true };
    }, BOUNDED);
    if ('done' in first) return first.done;

    const unmark = async (tx: Transaction) => {
      if (first.ours) await this.uploads.clearDeleted(tx, sha256);
    };
    try {
      // Read only once the mark is in: no working copy naming them saves now.
      const usedByContent = (
        (await this.references.placesOf([sha256])).get(sha256) ?? []
      ).some((place) => place.in !== 'branding');
      return await this.unit.run(async (tx) => {
        const decision = await decide(tx);
        if (decision.kind !== 'remove') {
          await unmark(tx);
          return decision;
        }
        // Without the mark (cleared meanwhile by a content upload of the
        // same bytes), a working copy may have named them while they were
        // looked for: they stay.
        const marked =
          (await this.uploads.deletedAmong(tx, [sha256])).length > 0;
        const removal = await this.#removeRecord(
          tx,
          actor,
          decision,
          decision.keepBytes || usedByContent || !marked,
        );
        await unmark(tx);
        return removal;
      }, BOUNDED);
    } catch (error) {
      if (first.ours) {
        await this.unit
          .run(async (tx) => {
            await this.uploads.lockHash(tx, sha256);
            await unmark(tx);
          }, BOUNDED)
          .catch((cleared: unknown) =>
            logger.warn(
              `The deletion mark of a branding image ${sha256} could not be cleared: ${String(cleared)}`,
            ),
          );
      }
      throw error;
    }
  }

  /** The last step, under both locks: the record, the audit event, then the bytes. */
  async #removeRecord(
    tx: Transaction,
    actor: Actor,
    { image }: { readonly image: BrandingImage },
    fileKept: boolean,
  ): Promise<Removal> {
    await this.store.removeImage(tx, image.sha256);
    await this.auditLog.record(tx, actor, {
      action: 'branding.image-delete',
      subject: BRANDING_SUBJECT,
      data: {
        sha256: image.sha256,
        contentType: image.contentType,
        size: image.size,
        width: image.width,
        height: image.height,
        fileKept,
      },
    });
    if (!fileKept) {
      // Still under the lock: a failure rolls the record back. The totals
      // last, so their row is not held across the blob store's call.
      await this.blobs.delete(image.sha256);
      await this.quota.removeMedia(tx, image.sha256, image.size);
    }
    return { kind: 'removed', fileKept };
  }
}
