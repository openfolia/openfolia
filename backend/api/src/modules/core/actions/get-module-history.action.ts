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
} from '../history-lookups.js';
import {
  HISTORY_WINDOW,
  type ModuleVersion,
  versionsSeen,
} from '../module-history.js';

/** A version on a page of a module's history, with what is looked up for it. */
export type ModuleHistoryEntry = HistoryEntry;

export interface ModuleHistoryPage extends Paginated<ModuleHistoryEntry> {
  /** Whether the line goes on past the commits looked at (`HISTORY_WINDOW`). */
  readonly truncated: boolean;
}

interface Input {
  readonly actor: Actor;
  /** Where the history is read: the ref's commit, as the actor may read it. */
  readonly snapshot: ReadableContent;
  readonly id: string;
  readonly lang: string;
  readonly page: PageRequest;
}

/**
 * A module's history at a ref: the commits on its first-parent line (the
 * newest `HISTORY_WINDOW`) after which the module, as the reader sees it
 * there, differs from before (`versionsSeen`), newest first, numbered
 * from the oldest, each with what its trailers claim (who, which change
 * set, approved by whom), the users among those the directory knows, and
 * the release tags holding exactly that file (the `RELEASES_CHECKED`
 * newest, each read as the actor reads released content, so a release
 * where the module lies outside their scope holds none).
 *
 * Not found, exactly like a module that does not exist, when the reader
 * sees no version of it, or when its file at the ref is one they may not
 * see (a module outside their scope has no history for them). A module
 * deleted at the ref still has its history, the newest version its
 * removal. Reading the older versions themselves is up to their commits'
 * permissions (`CompareModuleVersionsAction`).
 */
@Injectable()
export class GetModuleHistoryAction extends ActorAction<
  Input,
  ModuleHistoryPage
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
    lang,
    page,
  }: Input): Promise<ModuleHistoryPage> {
    const key = [snapshot.commit, snapshot.readingKey, lang, id]
      .map((part) => part.replaceAll('|', '||'))
      .join('|');
    const { versions, truncated } = await this.#histories.get(key, () =>
      this.history(snapshot, id, lang),
    );
    const { items, total } = paginate(versions, page);
    return {
      items: await this.#lookups.entries(actor, items, [lang, id], (content) =>
        content.moduleRevision(id, lang),
      ),
      total,
      truncated,
    };
  }

  private async history(
    snapshot: ReadableContent,
    id: string,
    lang: string,
  ): Promise<{ versions: readonly ModuleVersion[]; truncated: boolean }> {
    const notFound = () => new NotFoundError(`No module "${id}" in "${lang}".`);
    const history = await snapshot.moduleHistory(id, lang, HISTORY_WINDOW);
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
