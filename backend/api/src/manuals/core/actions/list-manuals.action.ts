import { Injectable } from '@nestjs/common';
import type { Manifest } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import {
  DesignsInUse,
  type DesignInUse,
} from '../../../content/core/design-in-use.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type {
  ManualIssue,
  ManualListing,
  ReadableContent,
  ReadableManual,
  SeenDeletedManual,
} from '../../../content/core/readable-content.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import {
  heldInReleased,
  openReleased,
} from '../../../modules/core/history-lookups.js';
import { HISTORY_WINDOW } from '../../../modules/core/module-history.js';
import { summarizeVariants, type VariantSummary } from '../variants.js';

export type ManualListEntry =
  | {
      id: string;
      manifest: Manifest;
      variants: VariantSummary[];
      issues: ManualIssue[];
      /** The page design it is printed with at the ref (#589). */
      design: DesignInUse;
      /** Set for a deleted manual (#321): its newest deletion; the rest is its last manifest. */
      deleted?: { commit: string; committedAt: string } | undefined;
    }
  | { id: string; error: string };

/** Which manuals a list holds: those there (the default), those deleted (#321), or both. */
export const MANUAL_STATUSES = ['current', 'deleted', 'any'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/**
 * One page of the manuals the actor may see, each naming only the modules
 * the actor may see; the total counts only those.
 * A manifest that cannot be read is listed with its error (to an actor who
 * may see a manual of any audience), so one broken file never hides the
 * rest.
 *
 * With `status` `deleted` (or `any`, both in one list, by ID), the manuals
 * deleted on the ref's first-parent line (among its newest
 * `HISTORY_WINDOW` commits) that have no manifest now, each from its last
 * manifest the actor may see (`ReadableContent.deletedManuals`, judged by
 * its audience as a manual there is), so one outside their scope is never
 * listed or counted, and each one listed has a history to open.
 *
 * Those last manifests are mostly in commits not released, so they are
 * read so only by a reader of drafts (`content.read.draft`, #410), and
 * only where their draft scopes show it alike. Anyone else (a reader of
 * released content only, or one whose draft scopes are narrower) is listed
 * a deleted manual only when
 * released content (`openReleased`: `main`'s head or a release tag) holds
 * exactly its last manifest, and from that manifest as they read it
 * there (its audience judged by that release, naming only what they may
 * see there): what they could read anyway. The others are not listed or
 * counted, as if never there.
 */
@Injectable()
export class ListManualsAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    page: PageRequest;
    status?: ManualStatus | undefined;
  },
  Paginated<ManualListEntry>
> {
  readonly policy = 'content.read';

  constructor(
    private readonly refs: ReadableRefs,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    snapshot,
    page,
    status = 'current',
  }: {
    actor: Actor;
    snapshot: ReadableContent;
    page: PageRequest;
    status?: ManualStatus | undefined;
  }): Promise<Paginated<ManualListEntry>> {
    const config = await snapshot.config();
    const listed: (
      | ManualListing
      | (ReadableManual & {
          id: string;
          deleted: { commit: string; committedAt: string };
        })
    )[] = [];
    if (status !== 'deleted') listed.push(...(await snapshot.manuals()));
    if (status !== 'current') {
      const files = await this.deleted(actor, snapshot);
      for (const { id, manifest, issues, commit, committedAt } of files) {
        listed.push({ id, manifest, issues, deleted: { commit, committedAt } });
      }
      listed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    const { items, total } = paginate(listed, page);
    const designs = new DesignsInUse(snapshot);
    return {
      total,
      items: await Promise.all(
        items.map(async (entry): Promise<ManualListEntry> =>
          'manifest' in entry
            ? {
                ...entry,
                variants: summarizeVariants(entry.manifest, config),
                design: await designs.of(entry.manifest, config),
              }
            : entry,
        ),
      ),
    };
  }

  /**
   * The deleted manuals listed (#410): each as `deletedManuals` gives it to
   * a reader of drafts whose draft scopes show it alike (the ref read as a
   * draft, or `content.read.draft` showing the same last manifest); the
   * others only when released content holds exactly their last manifest,
   * as the actor reads it at the newest released commit that does
   * (`main`'s head, then the release tags, newest first).
   */
  private async deleted(
    actor: Actor,
    snapshot: ReadableContent,
  ): Promise<SeenDeletedManual[]> {
    const { files } = await snapshot.deletedManuals(HISTORY_WINDOW);
    const drafts = snapshot.asDrafts();
    if (drafts === snapshot) return [...files];
    const asDrafts = new Map(
      (drafts ? (await drafts.deletedManuals(HISTORY_WINDOW)).files : []).map(
        (file) => [file.id, file],
      ),
    );
    const sameAsDraft = (file: SeenDeletedManual): boolean => {
      const draft = asDrafts.get(file.id);
      return (
        draft !== undefined &&
        draft.revision === file.revision &&
        JSON.stringify(draft.manifest) === JSON.stringify(file.manifest)
      );
    };
    const rest = files.filter((file) => !sameAsDraft(file));
    const released =
      rest.length === 0
        ? []
        : await openReleased(this.refs, this.openSnapshot, actor);
    const held = await heldInReleased(released, rest, async (content, file) => {
      const manual = await content.manualWithFile(file.id, file.revision);
      return manual && { ...file, ...manual };
    });
    const found = new Map(
      held.flatMap((file) => (file ? [[file.id, file] as const] : [])),
    );
    return files.flatMap((file) => {
      if (sameAsDraft(file)) return [file];
      const listed = found.get(file.id);
      return listed ? [listed] : [];
    });
  }
}
