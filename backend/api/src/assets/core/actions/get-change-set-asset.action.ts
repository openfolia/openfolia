import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BlobStore, isSha256 } from '../../../blobs/core/blob-store.js';
import { ChangeSetStore } from '../../../change-sets/core/change-set-store.js';
import { authorsChangeSet } from '../../../change-sets/core/working-copy-rules.js';
import type { RenditionWidth } from '../asset-rendition.js';
import { UPLOAD_TYPES } from '../asset-upload.js';
import { readBlob, Renditions, RenditionSettings } from '../renditions.js';
import { nameFits } from '../attachment-types.js';
import { AssetUploads } from '../asset-uploads.js';
import type { Asset } from './get-asset.action.js';

/** The 403's detail for another author's change set (to a reader of drafts). */
export const PREVIEW_AUTHOR_ONLY =
  'Only its author reads the images uploaded into a change set.';

/**
 * An image uploaded into a change set, for its author to preview before a
 * module refers to it (`GET /assets/:hash` serves an image only once a
 * module the reader may see refers to it). Only an image uploaded into
 * this change set, and only to its author, as their working copies are:
 * the author holds these very bytes, so nothing is shown they did not
 * send. Any other hash is not found, exactly like a missing one. With
 * `width`, its rendition at that width, after the same checks.
 */
@Injectable()
export class GetChangeSetAssetAction extends ActorAction<
  {
    actor: Actor;
    changeSetId: string;
    hash: string;
    width?: RenditionWidth | undefined;
  },
  Asset
> {
  readonly policy = 'content.read';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly uploads: AssetUploads,
    private readonly blobs: BlobStore,
    private readonly renditions: Renditions,
    private readonly settings: RenditionSettings,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    hash,
    width,
  }: {
    actor: Actor;
    changeSetId: string;
    hash: string;
    width?: RenditionWidth | undefined;
  }): Promise<Asset> {
    await authorsChangeSet(
      this.changeSets,
      actor,
      changeSetId,
      PREVIEW_AUTHOR_ONLY,
    );
    // The hash is not repeated: it is unchecked text until `isSha256`.
    const notFound = () =>
      new NotFoundError(
        `No such image was uploaded into change set ${changeSetId}.`,
      );
    if (!isSha256(hash)) throw notFound();
    const upload = await this.uploads.find(changeSetId, hash);
    if (!upload) throw notFound();
    if (width !== undefined) {
      const head = await this.blobs.head(hash);
      if (!head) throw notFound();
      return this.renditions.rendition(
        {
          sha256: hash,
          contentType: head.contentType,
          size: head.size,
          stored: true,
          read: () => readBlob(this.blobs, hash, this.settings.maxSourceBytes),
        },
        width,
      );
    }
    const stored = await this.blobs.get(hash);
    if (!stored) throw notFound();
    // Only an image upload's types are shown in place (the insert-image
    // dialog's preview); any other file is a download under its name.
    const image = (UPLOAD_TYPES as readonly string[]).includes(
      stored.contentType,
    );
    return {
      stream: stored.stream,
      type: stored.contentType,
      size: stored.size,
      ...(image
        ? {}
        : {
            // The upload's name only while it fits the stored type: the
            // bytes may have been kept under an earlier upload's type, and
            // the rules may have tightened since.
            download:
              upload.fileName !== undefined &&
              nameFits(upload.fileName, stored.contentType)
                ? { fileName: upload.fileName }
                : {},
          }),
    };
  }
}
