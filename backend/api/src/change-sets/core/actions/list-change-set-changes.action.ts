import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import { Recent } from '../../../base/core/recent.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ChangeSetBranches } from '../change-set-branches.js';
import { openSides } from '../change-set-sides.js';
import { subjectChange, type SubjectChange } from '../change-set-diff.js';
import { bySubjectKey, subjectOfPath } from '../commit.js';
import type { LockSubject } from '../lock.js';
import { seenOnBoth } from '../diff-sides.js';
import { changedPathsWithin } from '../review-scope.js';
import { GetChangeSetAction } from './get-change-set.action.js';

/** How many diffs (per pair of commits and what the reader sees) are kept. */
export const DIFFS_KEPT = 32;

/** How many subjects are read at once while diffing. */
const READ_AT_ONCE = 16;

/** One page of a change set's changes, and the two commits compared. */
export interface ChangeSetChanges extends Paginated<SubjectChange> {
  /** The change set's base commit. */
  readonly base: string;
  /** The head compared: the review head once submitted, else the branch's. */
  readonly head: string;
}

interface Input {
  readonly actor: Actor;
  readonly id: string;
  readonly page: PageRequest;
}

/**
 * What a change set changes: every module, manual, term and the
 * configuration that differs between
 * its base commit and its head (the review head once it is submitted, so a
 * reviewer sees what is reviewed; else its branch's head), with the
 * metadata fields and the blocks that differ, by block ID. Read through
 * `ReadableContent` as the actor may read each commit, and on each side
 * only what they would see on the other too (`seenOnBoth`), so a module or
 * manual they may not see on a side is not there on that side, exactly
 * like a missing one, and one they see on neither is not listed (nor
 * counted). The configuration and terms are read by every reader of a
 * commit, so they are listed for all of them. Files that are no subject's
 * (templates, images) are not listed.
 *
 * The change set is found as `GetChangeSetAction` finds it (another
 * author's is 404 for an actor without `content.read.draft`); its base and
 * head are opened as `openSides` opens them (for its author, #126, the base
 * as released content when the change set started from released content;
 * a branch that is gone is 409 `branch-missing`). More than `MAX_REVIEWED_PATHS` files 422
 * `too-many-changes`. Sorted by subject (the configuration, manuals,
 * modules by language and ID, then terms), paged after filtering.
 */
@Injectable()
export class ListChangeSetChangesAction extends ActorAction<
  Input,
  ChangeSetChanges
> {
  readonly policy = 'content.read';
  readonly #diffs = new Recent<readonly SubjectChange[]>(DIFFS_KEPT);

  constructor(
    private readonly getChangeSet: GetChangeSetAction,
    private readonly branches: ChangeSetBranches,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({ actor, id, page }: Input): Promise<ChangeSetChanges> {
    const changeSet = await this.getChangeSet.handle({ actor, id });
    const { base, head } = await openSides(
      this.branches,
      this.openSnapshot,
      actor,
      changeSet,
    );
    const changes = await this.between({ base, head });
    return { ...paginate(changes, page), base: base.commit, head: head.commit };
  }

  /**
   * Every change between a change set's two sides, as opened by
   * `openSides` for the actor (who has passed a policy of their own: this
   * checks none), unpaged. For other actions reading the same diff
   * (`ListChangeSetChecksAction`).
   */
  async between({
    base,
    head,
  }: {
    readonly base: ReadableContent;
    readonly head: ReadableContent;
  }): Promise<readonly SubjectChange[]> {
    // Keyed by both commits and what the actor sees on each, so two
    // readers share a diff only when they see the same.
    const key = [base.commit, base.readingKey, head.commit, head.readingKey]
      .map((part) => part.replaceAll('|', '||'))
      .join('|');
    return this.#diffs.get(key, () => this.diff(base, head));
  }

  private async diff(
    base: ReadableContent,
    head: ReadableContent,
  ): Promise<SubjectChange[]> {
    const changed = await changedPathsWithin(
      this.branches,
      base.commit,
      head.commit,
    );
    const subjects = new Map<string, LockSubject>();
    for (const { path } of changed) {
      const subject = subjectOfPath(path);
      if (subject) subjects.set(path, subject);
    }
    const ordered = [...subjects.values()].sort(bySubjectKey);
    const changes: SubjectChange[] = [];
    for (let i = 0; i < ordered.length; i += READ_AT_ONCE) {
      const batch = await Promise.all(
        ordered
          .slice(i, i + READ_AT_ONCE)
          .map(async (subject) =>
            subjectChange(
              subject,
              await seenOnBoth(base, head, subject),
              await seenOnBoth(head, base, subject),
            ),
          ),
      );
      for (const change of batch) if (change) changes.push(change);
    }
    return changes;
  }
}
