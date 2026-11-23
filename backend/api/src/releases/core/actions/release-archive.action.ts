import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  zipSize,
  zipStream,
  type ZipStreamEntry,
} from '../../../base/core/zip-stream.js';
import { BlobStore } from '../../../blobs/core/blob-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { Release } from '../release.js';
import {
  archiveEntryNames,
  archiveFileName,
  ReleaseArchiveSettings,
} from '../release-archive.js';
import { ReleaseOutputStore } from '../release-output-store.js';
import { ReleaseStore } from '../release-store.js';
import { releaseAt, visibleIn } from './release-outputs.action.js';

/** A release's files as one ZIP, as `GET …/outputs/archive` sends it. */
export interface ReleaseArchive {
  readonly release: Release;
  /** The name it downloads as (`archiveFileName`). */
  readonly fileName: string;
  /** The archive's exact length in bytes. */
  readonly size: number;
  /** How many files it holds: the outputs the reader may read that are done. */
  readonly files: number;
  /** How many outputs the reader may read are not done (queued, rendering or failed), so not in it. */
  readonly leftOut: number;
  /** The archive's bytes, read from the blob store one file at a time while they are taken. */
  readonly stream: AsyncIterable<Uint8Array>;
}

/**
 * `GET /releases/:id/outputs/archive` (#469): every output of the release
 * the reader may read (judged exactly as `GET /releases/:id/outputs`
 * judges it: `seesWholeManualIn` over the distinct audiences and
 * languages) that is `done`, as one stored ZIP, its files named
 * `<manual>/<lang>/<variant>.pdf` (`archiveEntryNames`). Streamed from the
 * blob store, one file at a time, so memory stays bounded. Those not done
 * are left out and counted (`leftOut`); none done is 409
 * `release-archive-empty`, and an archive larger than
 * `ReleaseArchiveSettings.maxBytes` is 422 `release-archive-too-large`.
 * Not audited, as a single file's download is not.
 */
@Injectable()
export class ReleaseArchiveAction extends ActorAction<
  { actor: Actor; releaseId: string },
  ReleaseArchive
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly blobs: BlobStore,
    private readonly settings: ReleaseArchiveSettings,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
  }: {
    actor: Actor;
    releaseId: string;
  }): Promise<ReleaseArchive> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    // Matched pair by pair, as the store's list matches them: a manual
    // with no audience (null) is never taken for one named "null".
    const visible = await visibleIn(this.outputs, content, release.id);
    // The PDFs: an offline package (#59) is a ZIP of its own, not one of the files.
    const readable = (await this.outputs.all(release.id)).filter(
      (o) =>
        o.kind === 'pdf' &&
        visible.some((v) => v.audience === o.audience && v.lang === o.lang),
    );
    const done = readable.filter(
      (o) => o.state === 'done' && o.sha256 !== null && o.size !== null,
    );
    if (done.length === 0) {
      throw new ConflictError(
        'release-archive-empty',
        readable.length === 0
          ? 'The release has no files you may read.'
          : `None of the release’s ${readable.length} files is ready yet.`,
        { total: readable.length, notReady: readable.length },
      );
    }
    const names = archiveEntryNames(done);
    const entries: ZipStreamEntry[] = done.map((o, i) => ({
      name: names[i] as string,
      size: o.size as number,
      open: async () => {
        const blob = await this.blobs.get(o.sha256 as string);
        if (!blob) {
          throw new NotFoundError(`The file of output "${o.id}" is gone.`);
        }
        return blob.stream;
      },
    }));
    const size = zipSize(entries);
    if (size > this.settings.maxBytes) {
      throw new UnprocessableError(
        'release-archive-too-large',
        `The release’s files make ${size} bytes, more than the ${this.settings.maxBytes} one archive may hold: download them one by one.`,
        { size, limit: this.settings.maxBytes },
      );
    }
    return {
      release,
      fileName: archiveFileName(release),
      size,
      files: done.length,
      leftOut: readable.length - done.length,
      stream: zipStream(entries, release.publishedAt),
    };
  }
}
