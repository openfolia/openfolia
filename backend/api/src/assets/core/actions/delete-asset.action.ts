import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
import {
  BOUNDED,
  type Transaction,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import {
  BlobStore,
  isSha256,
  type BlobInfo,
} from '../../../blobs/core/blob-store.js';
import { StorageQuota } from '../../../storage-usage/core/storage-quota.js';
import { ArchivedFiles } from '../archived-files.js';
import { AssetInfoReader } from '../asset-info.js';
import { AssetReferences, type ReferencePlace } from '../asset-references.js';
import { RENDITION_WIDTHS } from '../asset-rendition.js';
import { AssetRenditions } from '../asset-renditions.js';
import { AssetUploads } from '../asset-uploads.js';
import { HeldBlobs } from '../held-blobs.js';
import { requireEditsEverything, UNUSED_GRACE_MS } from '../unused.js';

/** At most this many places are named in a refusal. */
const PLACES_SHOWN = 50;

/** Why a file is not deleted: where it is used, or that it is too new. */
export type InUse =
  | ReferencePlace
  | { readonly in: 'recent-upload' | 'rendition' | 'release-output' };

/**
 * Deletes a file nobody uses (#255): its blob, its renditions and their
 * blobs, and its upload records, audited (`asset.delete`). Unused means
 * no content refers to it (`AssetReferences`: `main`, every tag and other
 * branch, every open change set's head, every working copy; an import's
 * bundle is never unused either), its last
 * upload or storing is more than `UNUSED_GRACE_MS` ago, and it is not a
 * rendition itself, nor an archived release PDF no upload records
 * (`ArchivedFiles`, kept for good, #429); else 409 `asset-in-use` with
 * `meta.usedIn`. The uploads of an archived PDF's bytes are deleted, the
 * file kept (`fileKept` in the audit event). Needs
 * `content.read.draft` and `content.edit`, each in a role whose scope
 * restricts nothing (`editsEverything`).
 *
 * No reference can slip in between the check and the delete: under the
 * hash's lock the file is first marked deleted (`AssetUploads.markDeleted`),
 * which saving a working copy that names it checks under the same lock and
 * refuses (409 `asset-deleted`); then where it is used is read again (a
 * save that came before the mark is seen there; a save point commits
 * only what working copies hold, and a merge only an open change set's
 * head, both counted), and only then, under the lock again, is it
 * deleted. A use found then clears the mark. An upload of the same bytes
 * clears it too, and moves the upload's time, so the last step refuses.
 */
@Injectable()
export class DeleteAssetAction extends ActorAction<
  { actor: Actor; hash: string },
  void
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly unit: UnitOfWork,
    private readonly uploads: AssetUploads,
    private readonly renditions: AssetRenditions,
    private readonly references: AssetReferences,
    private readonly blobs: BlobStore,
    private readonly infos: AssetInfoReader,
    private readonly auditLog: AuditLog,
    private readonly held: HeldBlobs,
    private readonly quota: StorageQuota,
    private readonly archived: ArchivedFiles,
  ) {
    super();
  }

  /** The clock for the grace period; tests set their own. */
  now: () => number = Date.now;

  protected async run({
    actor,
    hash,
  }: {
    actor: Actor;
    hash: string;
  }): Promise<void> {
    requireEditsEverything(actor);
    if (!isSha256(hash)) throw new NotFoundError('No such file.');
    // A first look, so a used file is refused without marking it.
    await this.unit.run((tx) => this.deletable(tx, hash), BOUNDED);
    this.refuseIfUsed(await this.references.placesOf([hash]), hash);
    await this.unit.run(async (tx) => {
      await this.deletable(tx, hash);
      await this.uploads.markDeleted(tx, hash);
    }, BOUNDED);
    // Read only once the mark is in: no working copy naming it saves now.
    let places: Map<string, ReferencePlace[]>;
    let checked: Set<string>;
    try {
      // Its renditions' bytes too, which content may share.
      checked = new Set([hash, ...(await this.#renditionHashes(hash))]);
      places = await this.references.placesOf([...checked]);
      this.refuseIfUsed(places, hash);
    } catch (error) {
      await this.#unmark(hash);
      throw error;
    }
    let removed;
    try {
      removed = await this.#remove(actor, hash, places, checked);
    } catch (error) {
      // The file stays (all rolled back, or nothing deleted): so does its use.
      if (!(error instanceof NotFoundError)) await this.#unmark(hash);
      throw error;
    }
    this.infos.forget(hash);
    for (const rendition of removed) this.infos.forget(rendition.sha256);
  }

  /** The hashes of the renditions recorded for `hash`. */
  async #renditionHashes(hash: string): Promise<string[]> {
    const found = await Promise.all(
      RENDITION_WIDTHS.map((width) => this.renditions.find(hash, width)),
    );
    return found.flatMap((rendition) => (rendition ? [rendition.sha256] : []));
  }

  async #unmark(hash: string): Promise<void> {
    await this.unit.run(async (tx) => {
      await this.uploads.lockHash(tx, hash);
      await this.uploads.clearDeleted(tx, hash);
    }, BOUNDED);
  }

  /** The last step, under the hash's lock: records, audit, then blobs. */
  #remove(
    actor: Actor,
    hash: string,
    places: ReadonlyMap<string, readonly ReferencePlace[]>,
    checked: ReadonlySet<string>,
  ) {
    return this.unit.run(async (tx) => {
      // The file's and its renditions' hash locks at once, in hash order
      // (as saving a working copy takes them): what records or holds a
      // rendition's bytes under its lock is decided below, not missed (#602).
      await this.uploads.lockHashes(tx, [...checked]);
      const stored = await this.deletable(tx, hash);
      // An upload of it meanwhile cleared the mark (and moved its time).
      if ((await this.uploads.deletedAmong(tx, [hash])).length === 0) {
        throw inUse([{ in: 'recent-upload' }]);
      }
      const renditions = await this.renditions.removeAllOf(tx, hash);
      const records = await this.uploads.removeAllOf(tx, hash);
      // The same bytes as an archived release PDF (an upload of a release's
      // file) or an import's bundle: the uploads go, the file stays for
      // what keeps it, and it was never counted as media.
      const apart = await this.quota.apartFromMedia(tx, hash);
      const fileKept = apart === 'pdf' || apart === 'bundle';
      await this.auditLog.record(tx, actor, {
        action: 'asset.delete',
        subject: { type: 'asset', id: hash },
        data: {
          size: stored?.size ?? null,
          contentType: stored?.contentType ?? null,
          uploads: records,
          renditions: renditions.length,
          fileKept,
        },
      });
      // The blobs last, still under the lock: a failure rolls the records
      // back. The renditions' first, so a failure leaves the source whole.
      for (const rendition of new Set(renditions.map((r) => r.sha256))) {
        // Bytes another source's rendition, an upload or content shares
        // stay, and so do a rendition's recorded since `places` was read,
        // and bytes a done release output records or an import or the
        // branding holds, as for the file itself (#602).
        if (
          rendition === hash ||
          !checked.has(rendition) ||
          places.has(rendition) ||
          (await this.renditions.isRendition(tx, rendition)) ||
          (await this.uploads.lastUploaded(tx, rendition)) !== undefined ||
          (await this.held.holds(tx, rendition)) !== null ||
          (await this.archived.has(tx, rendition))
        ) {
          continue;
        }
        await this.blobs.delete(rendition);
      }
      if (fileKept) return renditions;
      await this.blobs.delete(hash);
      // Off the storage used, in the transaction the delete rolls back
      // with; last, so the instance's totals row is not held across the
      // blob store's call.
      if (stored) await this.quota.removeMedia(tx, hash, stored.size, apart);
      return renditions;
    }, BOUNDED);
  }

  /**
   * Takes the hash's lock in `tx` and checks what the database and the
   * store say: there is a trace of the file, it is no rendition, and its
   * grace period is over. The stored blob's facts, if any.
   */
  private async deletable(
    tx: Transaction,
    hash: string,
  ): Promise<BlobInfo | undefined> {
    await this.uploads.lockHash(tx, hash);
    const [lastUploaded, stored] = await Promise.all([
      this.uploads.lastUploaded(tx, hash),
      this.blobs.head(hash),
    ]);
    if (lastUploaded === undefined && stored === undefined) {
      throw new NotFoundError(`No file "${hash}".`);
    }
    if (await this.renditions.isRendition(tx, hash)) {
      throw inUse([{ in: 'rendition' }]);
    }
    // An import's bundle, recorded since `places` was read (#332).
    const holder = await this.held.holds(tx, hash);
    if (holder) throw inUse([{ in: holder }]);
    // Kept for good (#241); with an upload of its bytes, only that goes.
    if (lastUploaded === undefined && (await this.archived.has(tx, hash))) {
      throw inUse([{ in: 'release-output' }]);
    }
    const since = Math.max(
      lastUploaded?.getTime() ?? 0,
      stored?.storedAt.getTime() ?? 0,
    );
    if (this.now() - since < UNUSED_GRACE_MS) {
      throw inUse([{ in: 'recent-upload' }], {
        deletableAt: new Date(since + UNUSED_GRACE_MS).toISOString(),
      });
    }
    return stored;
  }

  private refuseIfUsed(
    places: ReadonlyMap<string, readonly ReferencePlace[]>,
    hash: string,
  ): void {
    const used = places.get(hash);
    if (used) throw inUse(used);
  }
}

function inUse(
  places: readonly InUse[],
  extra: Record<string, unknown> = {},
): ConflictError {
  return new ConflictError(
    'asset-in-use',
    'The file is in use or was uploaded too recently; it is not deleted.',
    { usedIn: places.slice(0, PLACES_SHOWN), ...extra },
  );
}
