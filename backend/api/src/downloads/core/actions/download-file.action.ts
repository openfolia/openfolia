import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { Asset } from '../../../assets/core/actions/get-asset.action.js';
import { nameFits } from '../../../assets/core/attachment-types.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BlobStore, isSha256 } from '../../../blobs/core/blob-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  type ReleaseOutputFile,
  ReleaseOutputFileAction,
} from '../../../releases/core/actions/release-outputs.action.js';
import { ReleaseOutputStore } from '../../../releases/core/release-output-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import { parseDownloadId } from '../download.js';
import { attachmentIn, contentAt } from '../download-reads.js';

/** A download's file at one release, as `GET /downloads/:id/versions/:releaseId/file` sends it. */
export type DownloadFileResult =
  | {
      readonly kind: 'attachment';
      readonly hash: string;
      /** Always a download (`download` set), under the block's file name when it fits. */
      readonly asset: Asset;
    }
  | { readonly kind: 'manual'; readonly file: ReleaseOutputFile };

/**
 * `GET /downloads/:id/versions/:releaseId/file` (#139): the download's file as the release
 * holds it, for a reader who sees it there, judged as its versions judge it; else 404, exactly
 * like a missing one. The release must be one of the download's product.
 *
 * - An attachment: the block's file from the blob store, always a download under the block's
 *   `fileName` when it fits the stored type (`nameFits`, as `GET /assets/:hash` names one; else
 *   the hash), sent with the safe headers of #236 (`assetFile`).
 * - A manual's PDF: exactly `GET /releases/:id/outputs/:outputId/file` (#249,
 *   `ReleaseOutputFileAction`): who may read it, 409 `output-not-ready` until it is done.
 */
@Injectable()
export class DownloadFileAction extends ActorAction<
  { actor: Actor; id: string; releaseId: string },
  DownloadFileResult
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly blobs: BlobStore,
    private readonly outputFile: ReleaseOutputFileAction,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    releaseId,
  }: {
    actor: Actor;
    id: string;
    releaseId: string;
  }): Promise<DownloadFileResult> {
    const notFound = () =>
      new NotFoundError(
        `No file of download "${id}" at release "${releaseId}".`,
      );
    const key = parseDownloadId(id);
    if (!key) throw notFound();
    const release = await this.store.find(releaseId);
    if (!release || release.product !== key.product) throw notFound();
    if (key.kind === 'manual') {
      const output = await this.outputs.findOf(release.id, {
        manualId: key.manualId,
        variant: key.variant,
        lang: key.lang,
        kind: 'pdf',
      });
      if (!output) throw notFound();
      // Judges the reader, opens the tag and the blob, refuses one not done: #249's route.
      return {
        kind: 'manual',
        file: await this.outputFile.handle({
          actor,
          releaseId: release.id,
          outputId: output.id,
        }),
      };
    }
    const content = await contentAt(this.snapshots, actor, release);
    if (!content) throw notFound();
    const block = await attachmentIn(content, key, release.productFacet);
    const hash = block?.asset.slice('sha256:'.length);
    if (!block || !isSha256(hash)) throw notFound();
    const stored = await this.blobs.get(hash);
    if (!stored) throw notFound();
    return {
      kind: 'attachment',
      hash,
      asset: {
        stream: stored.stream,
        type: stored.contentType,
        size: stored.size,
        download: nameFits(block.fileName, stored.contentType)
          ? { fileName: block.fileName }
          : {},
      },
    };
  }
}
