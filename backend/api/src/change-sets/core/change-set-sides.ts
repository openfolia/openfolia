import type { Actor } from '../../access/core/actor.js';
import { ConflictError } from '../../base/core/errors.js';
import type { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ChangeSet } from './change-set.js';
import type { ChangeSetBranches } from './change-set-branches.js';
import { opensAsAuthor } from './own-work.js';

/** A change set's two sides, each as the actor may read that commit. */
export interface ChangeSetSides {
  /** Its base commit. */
  readonly base: ReadableContent;
  /** The review head once submitted, else its branch's head. */
  readonly head: ReadableContent;
}

/**
 * The base commit and the head of `changeSet` as `actor` may read them:
 * what its changes are listed between (`ListChangeSetChangesAction`) and
 * what comments are anchored in. The base is opened by its commit ID: for
 * its author (#126) as released content when the change set started from
 * released content (`opensAsAuthor`, `authoredBase`). The head is the
 * review head once submitted, else the branch's head, opened by the
 * branch's name where it is the branch's head (an author opens their own
 * branch); a submitted change set whose branch moved past its review head
 * opens that by commit ID, so for an author without `content.read.draft`
 * it is then 404. A branch that is gone is 409 `branch-missing`.
 */
export async function openSides(
  branches: ChangeSetBranches,
  openSnapshot: OpenSnapshotAction,
  actor: Actor,
  changeSet: ChangeSet,
): Promise<ChangeSetSides> {
  const [base, head] = await Promise.all([
    openCommit(
      openSnapshot,
      actor,
      changeSet.baseCommit,
      opensAsAuthor(actor, changeSet),
    ),
    headOf(branches, openSnapshot, actor, changeSet),
  ]);
  return { base, head };
}

/** The head compared, as the actor may read it. */
async function headOf(
  branches: ChangeSetBranches,
  openSnapshot: OpenSnapshotAction,
  actor: Actor,
  changeSet: ChangeSet,
): Promise<ReadableContent> {
  const branchHead = await branches.head(changeSet.branch);
  const head = changeSet.reviewHead ?? branchHead;
  if (head === undefined) {
    throw new ConflictError(
      'branch-missing',
      `The change set's branch ${changeSet.branch} is gone.`,
    );
  }
  if (head === branchHead) {
    const opened = await openSnapshot.handle({
      actor,
      ref: changeSet.branch,
    });
    // The branch moved since: a draft shows where it is now; a
    // submitted one what was submitted.
    if (opened.commit === head || changeSet.reviewHead === undefined) {
      return opened;
    }
  }
  return openCommit(openSnapshot, actor, head);
}

/**
 * The commit `commit` (a full ID) as the actor may read it; `authoredBase`
 * when it is the base of a change set that opens for them as its author.
 */
async function openCommit(
  openSnapshot: OpenSnapshotAction,
  actor: Actor,
  commit: string,
  authoredBase = false,
): Promise<ReadableContent> {
  const opened = await openSnapshot.handle({
    actor,
    ref: commit,
    ...(authoredBase && { authoredBase }),
  });
  if (opened.commit !== commit) {
    throw new Error('A commit opened as another; refusing to read it.');
  }
  return opened;
}
