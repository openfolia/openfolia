import { Injectable } from '@nestjs/common';
import {
  pageDesignAssetIssues,
  pageDesignAssets,
  pageDesignTemplateIssues,
  validatePageDesign,
  type PageDesign,
  type PageDesignIssue,
  type StoredAsset,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BlobStore, isSha256 } from '../../../blobs/core/blob-store.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

/** The bytes a font's format is told by (`fontFormatOf`). */
const HEAD_BYTES = 4;

/**
 * One page design (#390) with the problems found checking it against the
 * configuration (`validatePageDesign`) and its assets against the blob
 * store, else the repository's old layout (`assets/<sha256>`, #554)
 * (`pageDesignAssetIssues`: a logo, font or cover image not stored, a
 * font that is no TrueType, OpenType, WOFF or WOFF2 file), and its own template against the
 * repository's (`pageDesignTemplateIssues`, #396). Not found when there is no
 * such file; a file that is no design is `invalid-content`, as for every
 * content read. Every reader of the commit reads it.
 */
@Injectable()
export class GetPageDesignAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; id: string },
  { design: PageDesign; issues: PageDesignIssue[] }
> {
  readonly policy = 'content.read';

  constructor(private readonly blobs: BlobStore) {
    super();
  }

  protected async run({
    snapshot,
    id,
  }: {
    snapshot: ReadableContent;
    id: string;
  }): Promise<{ design: PageDesign; issues: PageDesignIssue[] }> {
    const [design, config, templates] = await Promise.all([
      snapshot.pageDesign(id),
      snapshot.config(),
      snapshot.designTemplateIds(),
    ]);
    if (!design) throw new NotFoundError(`No page design "${id}".`);
    // Only a font's first bytes are read; any other file is only asked for.
    const fonts = new Set(
      pageDesignAssets(design)
        .filter((a) => a.kind === 'font')
        .map((a) => a.asset),
    );
    const assets = await pageDesignAssetIssues(design, (asset) =>
      this.#stat(snapshot, id, asset, fonts.has(asset)),
    );
    return {
      design,
      issues: [
        ...validatePageDesign(design, config),
        ...pageDesignTemplateIssues(design, templates),
        ...assets,
      ],
    };
  }

  /**
   * A stored asset (`sha256:<hash>`), with a font's first bytes; `undefined` when none is
   * stored: neither in the blob store nor, the old layout, in the repository at this commit
   * (`assets/<hash>`, #554).
   */
  async #stat(
    snapshot: ReadableContent,
    id: string,
    asset: string,
    font: boolean,
  ): Promise<StoredAsset | undefined> {
    const hash = asset.slice('sha256:'.length);
    if (!isSha256(hash)) return undefined;
    const inRepository = async (): Promise<StoredAsset | undefined> => {
      const bytes = await snapshot.pageDesignAsset(id, hash, { read: font });
      return bytes && { head: bytes.subarray(0, HEAD_BYTES) };
    };
    if (!font) {
      return (await this.blobs.exists(hash))
        ? { head: new Uint8Array() }
        : inRepository();
    }
    const blob = await this.blobs.get(hash);
    if (!blob) return inRepository();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for await (const chunk of blob.stream) {
        const bytes = chunk as Uint8Array;
        chunks.push(bytes);
        length += bytes.length;
        if (length >= HEAD_BYTES) break;
      }
    } finally {
      blob.stream.destroy();
    }
    const head = new Uint8Array(Math.min(length, HEAD_BYTES));
    let at = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, head.length - at);
      head.set(part, at);
      at += part.length;
      if (at >= head.length) break;
    }
    return { head };
  }
}
