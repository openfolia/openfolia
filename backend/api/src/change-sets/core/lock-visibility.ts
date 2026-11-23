import type { Actor } from '../../access/core/actor.js';
import {
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
} from '../../base/core/errors.js';
import type { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { changeSetBranch } from './change-set.js';
import type { Lock } from './lock.js';
import { draftReadPermission, isActor, readsChangeSets } from './own-work.js';
import {
  draftLanguages,
  readsAllDrafts,
  seesSubject,
} from './subject-scope.js';

/** How many locks are checked against content at once. */
const CHECKED_AT_ONCE = 16;

/**
 * The locks of `locks` that `actor` may know of, in their order: the
 * actor holds `content.read.draft` and the subject, as committed on its
 * change set's branch, lies within that scope (`seesSubject`). A lock
 * outside it is left out, exactly as if it did not exist. One whose
 * branch the actor cannot open is left out too (fails closed). An actor
 * without `content.read.draft` knows of their own locks only (#126:
 * authors always see their own work), each within their `content.read`
 * scope on their own branch, which opens for them.
 */
export async function visibleLocks(
  openSnapshot: OpenSnapshotAction,
  actor: Actor,
  locks: readonly Lock[],
): Promise<Lock[]> {
  const drafts = readsChangeSets(actor);
  if (drafts && readsAllDrafts(actor)) return [...locks];
  const permission = draftReadPermission(actor);
  const languages = drafts ? draftLanguages(actor) : undefined;
  const snapshots = new Map<string, Promise<ReadableContent | undefined>>();
  const snapshotOf = (changeSetId: string) => {
    let found = snapshots.get(changeSetId);
    if (!found) {
      found = openSnapshot
        .handle({ actor, ref: changeSetBranch(changeSetId) })
        .catch((error: unknown) => {
          if (error instanceof NotFoundError || error instanceof ForbiddenError)
            return undefined;
          throw error;
        });
      snapshots.set(changeSetId, found);
    }
    return found;
  };
  const sees = async (lock: Lock): Promise<boolean> => {
    if (!drafts && !isActor(actor, lock.holder)) return false;
    if (
      lock.subject.type === 'module' &&
      languages !== undefined &&
      !languages.includes(lock.subject.lang)
    ) {
      return false;
    }
    const snapshot = await snapshotOf(lock.changeSetId);
    if (snapshot === undefined) return false;
    try {
      return await seesSubject(actor, snapshot, lock.subject, permission);
    } catch (error) {
      // A branch whose content cannot be read (a broken configuration)
      // hides its own locks, not everyone's list; anything else fails.
      if (error instanceof InvalidContentError) return false;
      throw error;
    }
  };
  // A few at a time, so one request never reads Git for every lock at once.
  const seen: boolean[] = [];
  for (let start = 0; start < locks.length; start += CHECKED_AT_ONCE) {
    seen.push(
      ...(await Promise.all(
        locks.slice(start, start + CHECKED_AT_ONCE).map(sees),
      )),
    );
  }
  return locks.filter((_, i) => seen[i]);
}

/** Whether `actor` may know of `lock` (`visibleLocks`). */
export async function seesLock(
  openSnapshot: OpenSnapshotAction,
  actor: Actor,
  lock: Lock,
): Promise<boolean> {
  return (await visibleLocks(openSnapshot, actor, [lock])).length === 1;
}
