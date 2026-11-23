import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import { isChangeSetId } from '../../change-sets/core/change-set.js';
import type { ChangeKind } from '../../change-sets/core/change-set-diff.js';
import {
  ACTOR_TRAILER,
  actorOfTrailer,
  APPROVED_BY_TRAILER,
  CHANGE_SET_TRAILER,
  MERGED_BY_TRAILER,
  MERGED_CHANGE_SET_TRAILER,
} from '../../change-sets/core/commit.js';
import type {
  SeenModuleVersion,
  SeenRevision,
} from '../../content/core/readable-content.js';

/** The most approvers a version names (a commit pushed from outside could name any number). */
export const MAX_APPROVERS = 50;

/** The most commits of a ref's first-parent line looked at for a history. */
export const HISTORY_WINDOW = 1000;

/**
 * A version of a module as the reader sees it: a commit on the ref's
 * first-parent line after which the module, as they may see it, differs
 * from before.
 */
export interface ModuleVersion {
  readonly commit: string;
  readonly committedAt: string;
  readonly message: string;
  /** 2 or more for a merge. */
  readonly parents: number;
  /** `added`, `changed` or `removed`, as the reader sees each side. */
  readonly change: ChangeKind;
  /** The file's revision after it (`moduleRevision`); undefined when removed. */
  readonly fileRevision?: string;
  /** The file after it cannot be read (shown only to a reader of all of its language). */
  readonly unreadable: boolean;
  /**
   * 1 for the oldest version, counting up; undefined when the walk was cut
   * (`HISTORY_WINDOW`) while the file already existed, since the count
   * would not start at the first.
   */
  readonly revision?: number;
  /** Who made it, as its trailers claim: `Merged-by`, else `Actor`. */
  readonly actor?: ChangeSetAuthor;
  /** The change set it came from, as its trailers claim: `Merged-change-set`, else `Change-set`. */
  readonly changeSetId?: string;
  /** Who approved it, as its `Approved-by` trailers claim, in order. */
  readonly approvedBy: readonly ChangeSetAuthor[];
}

/**
 * The versions of a module as the reader sees them, newest first, from
 * the versions of its file (`ReadableContent.moduleHistory`): a commit is a
 * version when the file as they see it after it differs from the file as
 * they see it before (the next older version, or `before` when the walk
 * was cut, else nothing). A revision they may not see is no file, so a
 * change from one hidden revision to another is no version, and one that
 * hides the module (its audience raised past their scope) is a removal.
 */
export function versionsSeen(history: {
  readonly versions: readonly SeenModuleVersion[];
  readonly truncated: boolean;
  readonly before: SeenRevision | undefined;
  readonly startsInWindow: boolean;
}): ModuleVersion[] {
  const listed: Omit<ModuleVersion, 'revision'>[] = [];
  let previous = history.truncated ? history.before : undefined;
  for (const version of [...history.versions].reverse()) {
    const { seen } = version;
    if (seen?.revision !== previous?.revision) {
      const change: ChangeKind =
        previous === undefined
          ? 'added'
          : seen === undefined
            ? 'removed'
            : 'changed';
      listed.push({
        commit: version.commit,
        committedAt: version.committedAt,
        message: version.message,
        parents: version.parents,
        change,
        ...(seen && { fileRevision: seen.revision }),
        unreadable: seen?.unreadable ?? false,
        ...claims(version.trailers),
      });
    }
    previous = seen;
  }
  return listed
    .map((version, i) => ({
      ...version,
      ...(history.startsInWindow && { revision: i + 1 }),
    }))
    .reverse();
}

/**
 * What a commit's trailers say of it: who made it, in which change set,
 * approved by whom. Only what they claim (anyone who could push the
 * commit could write them); a value that names no actor or change set is
 * left out.
 */
function claims(
  trailers: readonly { key: string; value: string }[],
): Pick<ModuleVersion, 'actor' | 'changeSetId' | 'approvedBy'> {
  const first = (key: string) =>
    trailers.find((t) => t.key.toLowerCase() === key.toLowerCase())?.value;
  const all = (key: string) =>
    trailers
      .filter((t) => t.key.toLowerCase() === key.toLowerCase())
      .map((t) => t.value);
  const merged = first(MERGED_BY_TRAILER);
  const actor = actorOfTrailer(
    merged ?? (first(ACTOR_TRAILER) as string | undefined) ?? '',
  );
  const changeSetId =
    first(MERGED_CHANGE_SET_TRAILER) ??
    (merged === undefined ? first(CHANGE_SET_TRAILER) : undefined);
  return {
    ...(actor && { actor }),
    ...(changeSetId !== undefined &&
      isChangeSetId(changeSetId) && { changeSetId }),
    approvedBy: [...new Set(all(APPROVED_BY_TRAILER))]
      .flatMap((value) => {
        const approver = actorOfTrailer(value);
        return approver ? [approver] : [];
      })
      .slice(0, MAX_APPROVERS),
  };
}
