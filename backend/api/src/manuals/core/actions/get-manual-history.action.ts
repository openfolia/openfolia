import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { UserDirectory } from '../../../access/core/user-directory.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import { Recent } from '../../../base/core/recent.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import {
  HISTORIES_KEPT,
  HistoryLookups,
  type HistoryEntry,
} from '../../../modules/core/history-lookups.js';
import {
  HISTORY_WINDOW,
  type ModuleVersion,
  versionsSeen,
} from '../../../modules/core/module-history.js';

/** A version on a page of a manual's history: as a module's, and where to read it. */
export interface ManualHistoryEntry extends HistoryEntry {
  /**
   * The commit to read this version at (`GET /manuals/:id/compare`): its
   * own for a reader of drafts; for a reader of released content only, the
   * released commit holding it (`HistoryLookups.released`).
   */
  readonly readAt: string;
}

/** A page of a manual's history: its versions as a module's are listed. */
export interface ManualHistoryPage extends Paginated<ManualHistoryEntry> {
  /** Whether the line goes on past the commits looked at (`HISTORY_WINDOW`). */
  readonly truncated: boolean;
}

interface Input {
  readonly actor: Actor;
  /** Where the history is read: the ref's commit, as the actor may read it. */
  readonly snapshot: ReadableContent;
  readonly id: string;
  readonly page: PageRequest;
}

/**
 * A manual's history at a ref, exactly as a module's
 * (`GetModuleHistoryAction`): the commits on its first-parent line (the
 * newest `HISTORY_WINDOW`) after which its manifest, as the reader sees it
 * there (`ReadableContent.manualHistory`: by its audience), differs from
 * before, newest first, numbered from the oldest, with what the trailers
 * claim, the users the directory knows and the release tags holding
 * exactly that manifest (as the actor reads each release).
 *
 * Not found, exactly like a manual that does not exist, when the reader
 * sees no version of it, or when its manifest at the ref (for one deleted
 * there: its last manifest) is one they may not see. A manual deleted at
 * the ref keeps its history, its newest version the removal.
 *
 * A reader without `content.read.draft` (#410) reads released content
 * only, so only the versions released content holds are listed to them
 * (`HistoryLookups.released`: `main`'s head, or a release tag, holding
 * exactly that manifest as they see it there), each to be read at that
 * released commit (`readAt`), never at its own, unreleased one; none
 * listed when a version they would see is there, but none released, is
 * not found too. Its revision number stays the one counted over every
 * version.
 */
@Injectable()
export class GetManualHistoryAction extends ActorAction<
  Input,
  ManualHistoryPage
> {
  readonly policy = 'content.read';
  readonly #histories = new Recent<{
    versions: readonly ModuleVersion[];
    truncated: boolean;
  }>(HISTORIES_KEPT);
  readonly #lookups: HistoryLookups;

  constructor(
    refs: ReadableRefs,
    openSnapshot: OpenSnapshotAction,
    users: UserDirectory,
  ) {
    super();
    this.#lookups = new HistoryLookups(refs, openSnapshot, users);
  }

  protected async run({
    actor,
    snapshot,
    id,
    page,
  }: Input): Promise<ManualHistoryPage> {
    const { versions, truncated } = await this.versions(snapshot, id);
    const revisionAt = (content: ReadableContent) => content.manualRevision(id);
    const listed = (await this.readsDrafts(snapshot, id, versions))
      ? versions.map((version) => ({ version, readAt: version.commit }))
      : await this.#lookups.released(
          actor,
          snapshot,
          versions,
          [id],
          revisionAt,
        );
    if (listed.length === 0 && versions.length > 0) {
      throw new NotFoundError(`No manual "${id}".`);
    }
    const { items, total } = paginate(listed, page);
    const entries = await this.#lookups.entries(
      actor,
      items.map((item) => item.version),
      [id],
      revisionAt,
    );
    return {
      items: entries.map((entry, i) => ({
        ...entry,
        readAt: (items[i] as (typeof items)[number]).readAt,
      })),
      total,
      truncated,
    };
  }

  /** The versions as `snapshot`'s reader sees them, kept per commit, reading key and manual. */
  private versions(
    snapshot: ReadableContent,
    id: string,
  ): Promise<{ versions: readonly ModuleVersion[]; truncated: boolean }> {
    const key = [snapshot.commit, snapshot.readingKey, id]
      .map((part) => part.replaceAll('|', '||'))
      .join('|');
    return this.#histories.get(key, () => this.history(snapshot, id));
  }

  /**
   * Whether the reader is listed every version (#410): when they read the
   * ref as a draft, or hold `content.read.draft` and their draft scopes
   * show them exactly these versions too (a narrower draft scope that
   * would show fewer, or other, takes the released path instead).
   */
  private async readsDrafts(
    snapshot: ReadableContent,
    id: string,
    versions: readonly ModuleVersion[],
  ): Promise<boolean> {
    const drafts = snapshot.asDrafts();
    if (drafts === snapshot) return true;
    if (!drafts) return false;
    let seen: readonly ModuleVersion[];
    try {
      seen = (await this.versions(drafts, id)).versions;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
    return (
      seen.length === versions.length &&
      seen.every((v, i) => {
        const other = versions[i] as ModuleVersion;
        return (
          v.commit === other.commit &&
          v.fileRevision === other.fileRevision &&
          v.unreadable === other.unreadable
        );
      })
    );
  }

  private async history(
    snapshot: ReadableContent,
    id: string,
  ): Promise<{ versions: readonly ModuleVersion[]; truncated: boolean }> {
    const notFound = () => new NotFoundError(`No manual "${id}".`);
    const history = await snapshot.manualHistory(id, HISTORY_WINDOW);
    if (!history) throw notFound();
    const versions = versionsSeen(history);
    // None listed: no version they see, unless it is there, unchanged
    // since before the oldest commit looked at.
    if (versions.length === 0 && history.before === undefined) {
      throw notFound();
    }
    return { versions, truncated: history.truncated };
  }
}
