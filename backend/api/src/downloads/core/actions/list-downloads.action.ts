import { type Manifest, textIn } from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  type PageRequest,
  paginate,
  type Paginated,
} from '../../../base/core/paging.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { visibleIn } from '../../../releases/core/actions/release-outputs.action.js';
import { outputFileName } from '../../../releases/core/release-output.js';
import { ReleaseOutputStore } from '../../../releases/core/release-output-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import type { Release } from '../../../releases/core/release.js';
import {
  type Download,
  type DownloadFilter,
  downloadId,
  isForProduct,
  matchesDownload,
} from '../download.js';
import { attachmentFile, contentAt } from '../download-reads.js';

/**
 * `GET /downloads` (#139): every downloadable file of each product at its latest release (the
 * newest that stands, cut from `main`): one per attachment block of the modules for that
 * product (#236; module, block and language) and one per PDF of a manual (#249; manual,
 * variant and language) that is done. Read as the reader reads released content: an
 * attachment only in a module they may see at the tag (`ReadableContent.attachments`), a PDF
 * only of a manual one of their roles reads whole there (`visibleIn`, as the release's outputs
 * list judges it). Filtered before paging, so neither the list nor the total tells of a file
 * outside their scope. Ordered by product, then attachments (by module, language, block order)
 * before manuals (by manual, variant, language).
 *
 * Bounded: one tag opened per product; a tag's attachments are worked out once per commit and
 * reading key (`attachmentListings`), its PDFs are one query.
 */
@Injectable()
export class ListDownloadsAction extends ActorAction<
  { actor: Actor; filter: DownloadFilter; page: PageRequest },
  Paginated<Download>
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: {
    actor: Actor;
    filter: DownloadFilter;
    page: PageRequest;
  }): Promise<Paginated<Download>> {
    const latest =
      filter.product === undefined
        ? await this.store.latestOfEach()
        : [await this.store.latest(filter.product)].filter(
            (r): r is Release => r !== undefined,
          );
    const found: Download[] = [];
    for (const release of latest.sort((a, b) =>
      compare(a.product, b.product),
    )) {
      const content = await contentAt(this.snapshots, actor, release);
      if (!content) continue;
      if (filter.kind !== 'manual') {
        found.push(...(await this.attachments(content, release)));
      }
      if (filter.kind !== 'attachment') {
        found.push(...(await this.manuals(content, release, filter.lang)));
      }
    }
    return paginate(
      found.filter((download) => matchesDownload(download, filter)),
      page,
    );
  }

  /** The attachments of the modules for the release's product, as the reader sees them there. */
  private async attachments(
    content: ReadableContent,
    release: Release,
  ): Promise<Download[]> {
    const seen = new Set<string>();
    const found: Download[] = [];
    for (const use of await content.attachments()) {
      if (!isForProduct(use.facets, release.productFacet, release.product)) {
        continue;
      }
      const key = {
        kind: 'attachment' as const,
        product: release.product,
        moduleId: use.moduleId,
        blockId: use.block.id,
        lang: use.lang,
      };
      const id = downloadId(key);
      // A block ID is unique in its module; should one repeat, its first block is the download.
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({
        id,
        key,
        name: use.block.name,
        moduleTitle: use.title,
        release,
        ...attachmentFile(use.block),
      });
    }
    return found;
  }

  /** The release's PDFs that are done, of the manuals the reader reads whole there. */
  private async manuals(
    content: ReadableContent,
    release: Release,
    lang: string | undefined,
  ): Promise<Download[]> {
    const visible = await visibleIn(this.outputs, content, release.id);
    if (visible.length === 0) return [];
    const readable = new Set(visible.map((v) => `${v.audience}|${v.lang}`));
    const { source } = (await content.config()).languages;
    const titles = new Map<string, Manifest['title']>();
    for (const entry of await content.manuals()) {
      if ('manifest' in entry) titles.set(entry.id, entry.manifest.title);
    }
    return (await this.outputs.all(release.id))
      .filter(
        (o) =>
          // Only a manual's PDF is a download; other kinds of output (#59's packages, which will
          // have no manual) are not, and are left out before anything reads their manual.
          o.kind === 'pdf' &&
          o.state === 'done' &&
          o.sha256 !== null &&
          o.size !== null &&
          (lang === undefined || o.lang === lang) &&
          readable.has(`${o.audience}|${o.lang}`),
      )
      .map((o) => {
        const key = {
          kind: 'manual' as const,
          product: release.product,
          manualId: o.manualId,
          lang: o.lang,
          variant: o.variant,
        };
        return {
          id: downloadId(key),
          key,
          // The manual's title in the PDF's language, else the source language's.
          name: textOr(titles.get(o.manualId), o.lang, source) ?? o.manualId,
          moduleTitle: null,
          release,
          sha256: o.sha256 as string,
          size: o.size as number,
          mediaType: 'application/pdf',
          fileName: outputFileName(o, release.revision),
          description: null,
        };
      });
  }
}

const textOr = (
  title: Manifest['title'] | undefined,
  lang: string,
  source: string,
): string | undefined =>
  title === undefined ? undefined : textIn(title, lang, source);

/** Code-unit order, so the result does not depend on the locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
