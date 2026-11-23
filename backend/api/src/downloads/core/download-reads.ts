import { type Attachment, walk } from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { readingKey } from '../../access/core/reading-scope.js';
import { InvalidContentError, NotFoundError } from '../../base/core/errors.js';
import { Recent } from '../../base/core/recent.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { Release } from '../../releases/core/release.js';
import {
  type DownloadFile,
  type DownloadKey,
  isForProduct,
} from './download.js';

/**
 * A release's tag opened as `actor` reads released content; undefined when it cannot be
 * opened as theirs or no longer points to the release's commit (a tag is never moved, so that
 * is a repository changed by hand).
 */
export async function contentAt(
  snapshots: OpenSnapshotAction,
  actor: Actor,
  release: Release,
): Promise<ReadableContent | undefined> {
  try {
    const content = await snapshots.handle({ actor, ref: release.tag });
    return content.commit === release.commit ? content : undefined;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/**
 * The attachment block a download names, in its module as the actor reads it at `content`
 * (one module file read, never the whole tree); undefined when the module is not there for
 * them, cannot be read, is not for the download's product (`isForProduct`) or holds no
 * attachment block of that ID.
 */
export async function attachmentIn(
  content: ReadableContent,
  key: Extract<DownloadKey, { kind: 'attachment' }>,
  productFacet: string,
): Promise<Attachment | undefined> {
  let module;
  try {
    module = await content.module(key.moduleId, key.lang);
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
  if (
    !module ||
    !isForProduct(module.meta.facets ?? {}, productFacet, key.product)
  ) {
    return undefined;
  }
  for (const { kind, node } of walk(module.blocks)) {
    if (
      kind === 'block' &&
      node.type === 'attachment' &&
      node.id === key.blockId
    ) {
      return node;
    }
  }
  return undefined;
}

/** An attachment block's file, as a download lists it. */
export function attachmentFile(block: Attachment): DownloadFile {
  return {
    sha256: block.asset.slice('sha256:'.length),
    size: block.size,
    mediaType: block.mediaType,
    fileName: block.fileName,
    description: block.description ?? null,
  };
}

/** How many downloads' observations are kept (`DownloadObservations`), per reading key. */
export const OBSERVATIONS_KEPT = 256;

/**
 * What each release holds of a download, as one reading key sees it, kept by release (#139):
 * a release's tag never moves, so what a reader with that key sees there never changes, and a
 * download's versions read only the releases cut since they were last asked for. Only what
 * never changes is kept (the caller says: a manual's output still rendering is not).
 */
@Injectable()
export class DownloadObservations {
  readonly #kept = new Recent<Map<string, DownloadFile | null>>(
    OBSERVATIONS_KEPT,
  );

  /**
   * The releases' observations kept for `downloadId` and the actor's reading key, a new
   * (empty) entry when there are none: ask only for a download known to exist (#764), so an
   * invented ID never takes one of the `OBSERVATIONS_KEPT`.
   */
  async of(
    actor: Actor,
    downloadId: string,
  ): Promise<Map<string, DownloadFile | null>> {
    return this.#kept.get(this.#key(actor, downloadId), async () => new Map());
  }

  /** What `of` keeps for `downloadId` and the actor's reading key, without making an entry. */
  async peek(
    actor: Actor,
    downloadId: string,
  ): Promise<ReadonlyMap<string, DownloadFile | null> | undefined> {
    return this.#kept.peek(this.#key(actor, downloadId));
  }

  /** How many downloads' observations are kept (tests). */
  get size(): number {
    return this.#kept.size;
  }

  #key(actor: Actor, downloadId: string): string {
    return `${readingKey(actor, 'content.read')}|${downloadId}`;
  }

  /** Forgets everything kept (tests). */
  clear(): void {
    this.#kept.clear();
  }
}
