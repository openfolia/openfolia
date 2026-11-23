import type { Actor } from '../../access/core/actor.js';
import { allows, ANYWHERE } from '../../access/core/allows.js';
import type { ReadPermission } from '../../content/core/readable-content.js';
import type { ChangeSet, ChangeSetAuthor } from './change-set.js';

/**
 * Authors always see their own work (#126). A holder of
 * `content.read.draft` (in any scope) reads every change set, its locks
 * and working copies, as before; anyone else reads only their own, and
 * another author's is not there for them, exactly like one that does not
 * exist (#125).
 */
export function readsChangeSets(actor: Actor): boolean {
  return allows(actor, 'content.read.draft', ANYWHERE);
}

/** Whether `author` (of a change set, or a lock's holder) is `actor`. */
export function isActor(actor: Actor, author: ChangeSetAuthor): boolean {
  return author.kind === actor.kind && author.id === actor.id;
}

/**
 * Whether `changeSet`'s branch opens for `actor` as its author, without
 * `content.read.draft` (`AuthoredBranches`): they are its author and it
 * started from released content. A change set started from a draft (by
 * someone who then held `content.read.draft`) holds others' unreleased
 * work on its branch, which is not theirs to keep reading once that
 * permission is gone.
 */
export function opensAsAuthor(
  actor: Actor,
  changeSet: Pick<ChangeSet, 'author' | 'baseReleased'>,
): boolean {
  return isActor(actor, changeSet.author) && changeSet.baseReleased;
}

/**
 * The permission whose scope filters what an actor sees of change sets'
 * content (working copies, locked subjects): `content.read.draft` for its
 * holders, as before; `content.read` for an author without it, who sees
 * only their own work, through the scope they read released content with
 * (as their own branch opens for them: `OpenSnapshotAction`).
 */
export function draftReadPermission(actor: Actor): ReadPermission {
  return readsChangeSets(actor) ? 'content.read.draft' : 'content.read';
}
