import type { ExistingIds } from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { UnprocessableError } from '../../base/core/errors.js';
import { type BlobStore, isSha256 } from '../../blobs/core/blob-store.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { AssetUploads } from './asset-uploads.js';

/**
 * Where a module may use a file the actor may read: the file references
 * of some content as the actor reads it (`ReadableContent.assetUsage()`),
 * or `undefined` for content they may not open. Asked only when a hash is
 * still undecided, in order.
 */
export type UsagePlace = () => Promise<
  ReadonlyMap<string, unknown> | undefined
>;

/** A place from content already opened for the actor; its usage read at most once. */
export function usageOf(content: Pick<ReadableContent, 'assetUsage'>) {
  let usage: Promise<ReadonlyMap<string, unknown>> | undefined;
  return (): Promise<ReadonlyMap<string, unknown>> =>
    (usage ??= content.assetUsage());
}

/**
 * The files an actor may name by their hash without sending them (#332,
 * #335): a reference to anything else would let them read, or learn
 * whether the store holds, bytes they may not see. One rule for every
 * path that takes such a reference (an import, a working copy, a save
 * point). A file counts when either
 *
 * - a module the actor may see in one of the given places uses it (the
 *   places the caller names: an import's target branch; a change set's
 *   branch and its base); or
 * - it was uploaded into a change set the actor is the author of
 *   (`AssetUploads.uploadedForAuthor`: the only uploads anyone may read
 *   before content refers to them, by the author's preview).
 *
 * Nothing else: not another author's upload, not an import's uploaded
 * bundle (never an asset upload), not a blob only content outside the
 * actor's scope uses. The blob store is never asked about such a hash,
 * so neither the answer nor what is looked up depends on whether it
 * holds it.
 */
@Injectable()
export class ReadableAssets {
  constructor(private readonly uploads: AssetUploads) {}

  /**
   * Of `hashes` (SHA-256, hex), those the actor may not name, each once,
   * sorted; a malformed one is always among them. One query for the
   * uploads, then the places in order, only while some hash is left.
   */
  async unreadable(
    actor: Actor,
    hashes: readonly string[],
    places: readonly UsagePlace[],
  ): Promise<string[]> {
    const asked = [...new Set(hashes)];
    const malformed = asked.filter((hash) => !isSha256(hash));
    let left = asked.filter(isSha256);
    if (left.length > 0) {
      const own = new Set(
        await this.uploads.uploadedForAuthor(
          { kind: actor.kind, id: actor.id },
          left,
        ),
      );
      left = left.filter((hash) => !own.has(hash));
    }
    for (const place of places) {
      if (left.length === 0) break;
      const usage = await place();
      if (usage) left = left.filter((hash) => !usage.has(`sha256:${hash}`));
    }
    return [...malformed, ...left].sort();
  }

  /**
   * 422 `unknown-asset` (`meta.assets`: the references refused, as
   * `sha256:<hash>`) when the actor may not name one of `hashes`
   * (`unreadable`). One answer whether a refused file is stored, someone
   * else's, or never was.
   */
  async refuseUnreadable(
    actor: Actor,
    hashes: readonly string[],
    places: readonly UsagePlace[],
  ): Promise<void> {
    const refused = await this.unreadable(actor, hashes, places);
    if (refused.length > 0) throw unknownAssets(refused);
  }

  /**
   * The stored files an import may refer to without carrying them (#332),
   * for the import validator: those the importer may name in `snapshot`
   * (the target branch as they read it) that the store holds. Any other
   * reference is answered exactly as one to bytes the store does not hold
   * (`false`, so `missing-asset`), and the store is asked only about a
   * file the importer may name.
   */
  storedFor(
    actor: Actor,
    snapshot: Pick<ReadableContent, 'assetUsage'>,
    blobs: Pick<BlobStore, 'exists'>,
  ): ExistingIds {
    const place = usageOf(snapshot);
    return {
      has: async (reference: string) => {
        if (!reference.startsWith('sha256:')) return false;
        const hash = reference.slice('sha256:'.length);
        if (!isSha256(hash)) return false;
        const refused = await this.unreadable(actor, [hash], [place]);
        return refused.length === 0 && blobs.exists(hash);
      },
    };
  }
}

/** The answer to a reference the actor may not name (`ReadableAssets.refuseUnreadable`). */
export function unknownAssets(hashes: readonly string[]): UnprocessableError {
  return new UnprocessableError(
    'unknown-asset',
    'The content names a file that is not stored or that you may not use; upload it into this change set.',
    { assets: hashes.map((hash) => `sha256:${hash}`) },
  );
}
