import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { mapAtMost } from '../../../base/core/map-at-most.js';
import {
  type PageRequest,
  paginate,
  type Paginated,
} from '../../../base/core/paging.js';
import { OpenReleasedSnapshotsAction } from '../../../content/core/actions/open-released-snapshots.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { outputFileName } from '../../../releases/core/release-output.js';
import { ReleaseOutputStore } from '../../../releases/core/release-output-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import type { Release } from '../../../releases/core/release.js';
import {
  type DownloadFile,
  type DownloadKey,
  type DownloadVersion,
  MAX_VERSION_RELEASES,
  type Observation,
  parseDownloadId,
  versionsOf,
} from '../download.js';
import {
  attachmentFile,
  attachmentIn,
  DownloadObservations,
} from '../download-reads.js';

/** How many releases' files are read at once for a download's versions. */
const READS_AT_ONCE = 8;

/** One page of a download's versions. */
export interface DownloadVersionsPage extends Paginated<DownloadVersion> {
  /** More releases of the product than `MAX_VERSION_RELEASES`: older ones were not looked at. */
  readonly truncated: boolean;
}

/** What releases hold of a download, by release ID (null: none for the reader there). */
type Observed = Map<string, DownloadFile | null>;

/**
 * `GET /downloads/:id/versions` (#139): the download's file across its product's releases cut
 * from `main` (withdrawn ones too), newest first, a version only where the file's hash differs
 * from the version before (`versionsOf`). Each release is judged as the reader reads its tag: an
 * attachment only where they may see its module there (and the module is for the product), a
 * manual's PDF only where one of their roles reads the manual whole (`seesWholeManualIn`, as
 * the release's outputs judge it) and it is done. A version outside their scope is neither
 * listed nor counted.
 *
 * A download is looked for first at the product's latest release (the newest that stands; with
 * none standing, the newest), #764: one the reader does not get there is 404 at once, exactly
 * like one that does not exist, without reading any other release or keeping anything for it.
 * So an invented ID costs one release's reads, and a file no longer in the latest release has no
 * versions to show (the list does not show it either).
 *
 * Bounded (#764): the `MAX_VERSION_RELEASES` newest releases (`truncated` past them); their tags
 * are resolved from one ref listing (`OpenReleasedSnapshotsAction`), never one per tag; per
 * release, an attachment reads its module file and the configuration at the tag's commit (each
 * parsed once per file revision), never the tree, and a manual's outputs are one query for all
 * of them. What a release holds never changes for a reading key, so it is kept
 * (`DownloadObservations`) and a later read opens only the tags of releases cut since.
 */
@Injectable()
export class DownloadVersionsAction extends ActorAction<
  { actor: Actor; id: string; page: PageRequest },
  DownloadVersionsPage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly released: OpenReleasedSnapshotsAction,
    private readonly observations: DownloadObservations,
  ) {
    super();
  }

  protected async run({
    actor,
    id,
    page,
  }: {
    actor: Actor;
    id: string;
    page: PageRequest;
  }): Promise<DownloadVersionsPage> {
    const notFound = () => new NotFoundError(`No download "${id}".`);
    const key = parseDownloadId(id);
    if (!key) throw notFound();
    const { releases, truncated } = await this.store.mainLine(
      key.product,
      MAX_VERSION_RELEASES,
    );
    // The product's latest release: the newest that stands (all of them are `main`'s).
    const latest = releases.find((r) => r.withdrawal === null);
    const first = latest ?? releases[0];
    if (!first) throw notFound();
    // Is it there at all? Asked of the latest release alone, before anything is kept for it.
    const known = await this.observations.peek(actor, id);
    const probe: Observed = new Map();
    const passing: Observed = new Map();
    if (known?.has(first.id)) {
      probe.set(first.id, known.get(first.id) ?? null);
    } else {
      await this.observe(actor, key, [first], probe, passing);
    }
    if (!(probe.get(first.id) ?? passing.get(first.id))) throw notFound();
    const kept = await this.observations.of(actor, id);
    for (const [release, file] of probe) kept.set(release, file);
    const missing = releases.filter(
      (r) => !kept.has(r.id) && !passing.has(r.id),
    );
    await this.observe(actor, key, missing, kept, passing);
    const observed: Observation[] = releases.map((release) => ({
      release,
      file: (kept.get(release.id) ?? passing.get(release.id)) || undefined,
    }));
    return {
      ...paginate(versionsOf(observed, latest?.id, key.lang), page),
      truncated,
    };
  }

  /**
   * What each of `releases` holds of the download as the actor sees it: into `kept` what never
   * changes, into `passing` what may still (a manual's output not done yet).
   */
  private async observe(
    actor: Actor,
    key: DownloadKey,
    releases: readonly Release[],
    kept: Observed,
    passing: Observed,
  ): Promise<void> {
    if (releases.length === 0) return;
    if (key.kind === 'attachment') {
      await this.attachments(actor, key, releases, kept);
    } else {
      await this.manuals(actor, key, releases, kept, passing);
    }
  }

  /**
   * Each release's tag opened as the actor reads released content, by one ref listing for all
   * of them; undefined where it cannot be opened or no longer points to the release's commit (a
   * tag is never moved, so that is a repository changed by hand).
   */
  private async contentAt(
    actor: Actor,
    releases: readonly Release[],
  ): Promise<(ReadableContent | undefined)[]> {
    if (releases.length === 0) return [];
    const opened = await this.released.handle({
      actor,
      // By its full name: a branch of the same name never stands in for it.
      refs: releases.map((r) => `refs/tags/${r.tag}`),
    });
    return releases.map((release, i) => {
      const content = opened[i];
      return content?.commit === release.commit ? content : undefined;
    });
  }

  /** Per release, the attachment block's file there (null: none for the actor), into `found`: a tag never changes. */
  private async attachments(
    actor: Actor,
    key: Extract<DownloadKey, { kind: 'attachment' }>,
    releases: readonly Release[],
    found: Observed,
  ): Promise<void> {
    const contents = await this.contentAt(actor, releases);
    await mapAtMost(releases, READS_AT_ONCE, async (release, i) => {
      const content = contents[i];
      // A tag that cannot be opened now is not remembered: it is asked again next time.
      if (!content) return;
      const block = await attachmentIn(content, key, release.productFacet);
      found.set(release.id, block ? attachmentFile(block) : null);
    });
  }

  /**
   * Per release, the manual's PDF there (null: none the actor may read). Into `kept` only once
   * it is settled, a done output (which never changes); a release without the output yet (its
   * planning may still add it) or with one queued, rendering or failed (it may become done) is
   * answered (`passing`) and asked again next time. Only the tags of releases with a done PDF
   * are opened.
   */
  private async manuals(
    actor: Actor,
    key: Extract<DownloadKey, { kind: 'manual' }>,
    releases: readonly Release[],
    kept: Observed,
    passing: Observed,
  ): Promise<void> {
    const rows = new Map(
      (
        await this.outputs.across(
          releases.map((r) => r.id),
          {
            manualId: key.manualId,
            variant: key.variant,
            lang: key.lang,
            kind: 'pdf',
          },
        )
      ).map((o) => [o.releaseId, o]),
    );
    const done = releases.flatMap((release) => {
      const output = rows.get(release.id);
      if (
        !output ||
        output.state !== 'done' ||
        output.sha256 === null ||
        output.size === null
      ) {
        passing.set(release.id, null);
        return [];
      }
      return [{ release, output, sha256: output.sha256, size: output.size }];
    });
    const contents = await this.contentAt(
      actor,
      done.map((d) => d.release),
    );
    await mapAtMost(
      done,
      READS_AT_ONCE,
      async ({ release, output, sha256, size }, i) => {
        const content = contents[i];
        if (!content) return;
        const readable = await content.seesWholeManualIn(
          output.audience ?? undefined,
          output.lang,
        );
        kept.set(
          release.id,
          readable
            ? {
                sha256,
                size,
                mediaType: 'application/pdf',
                fileName: outputFileName(output, release.revision),
                description: null,
              }
            : null,
        );
      },
    );
  }
}
