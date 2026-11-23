import type { ChangeSetAuthor } from './change-set.js';
import type { BranchChange } from './commit.js';

/** A change-set branch and the commit it points to. */
export interface BranchHead {
  readonly name: string;
  readonly commit: string;
}

/** The most commits of a change set's own line `writers` reads (#597). */
export const MAX_WRITER_COMMITS = 20_000;

/**
 * Port: the change sets' branches in the content repository. Every ref
 * change is a compare-and-swap; only branches under `BRANCH_PREFIX` are
 * ever touched.
 */
export abstract class ChangeSetBranches {
  /**
   * Creates `name` at `commit`. Throws `ConflictError` (`branch-exists`)
   * when the branch exists already; nothing is changed then.
   */
  abstract create(name: string, commit: string): Promise<void>;

  /**
   * Deletes `name` if it still points to `expected`. False when it moved
   * or is gone (nothing changed).
   */
  abstract deleteIfAt(name: string, expected: string): Promise<boolean>;

  /**
   * Whether `commit`, the head of the branch `name`, is in the history of
   * no branch or tag outside `BRANCH_PREFIX`: deleting `name` could lose
   * it. Other change-set branches do not count (they may be orphans
   * removed at the same time).
   */
  abstract hasOwnCommits(name: string, commit: string): Promise<boolean>;

  /**
   * The branch a change set starts from when none is given: the server's
   * default ref (`CCMS_DEFAULT_REF`), or the branch `HEAD` names when that
   * is `HEAD`. Undefined when `HEAD` names no branch; a default that is a
   * tag or commit comes back as it is (and is no branch to start from).
   */
  abstract defaultBase(): Promise<string | undefined>;

  /** Every branch under `BRANCH_PREFIX`. */
  abstract list(): Promise<BranchHead[]>;

  /**
   * The first half of a commit: checks `changes` and `message` as
   * `commit` would and writes the tree `changes` make of `parent`'s
   * (objects only: no commit, no ref moves). Returns that tree, for
   * `commit`. A message or change that can never be committed is an
   * `UnprocessableError`.
   */
  abstract prepare(
    name: string,
    request: {
      readonly parent: string;
      readonly changes: readonly BranchChange[];
      readonly message: string;
      readonly author: ChangeSetAuthor;
      readonly changeSetId: string;
      /** Who wrote what it carries over from another change set (`commit`). */
      readonly carried?: readonly ChangeSetAuthor[];
    },
  ): Promise<{ tree: string }>;

  /**
   * Commits `tree` (from `prepare`) on top of `parent` and moves the
   * branch `name` from `parent` to it (compare-and-swap), with `author` as
   * its author and committer and trailers naming the change set and the
   * author (for people reading the history: recovery never trusts them).
   * `carried`, for a commit carrying another change set's diff over (a
   * carry-forward, a move onto a rewritten base), names who wrote that diff,
   * one `Carried-author` trailer each (`writers`, #597). Returns the new
   * commit, or `{ moved }` (where the branch is now) when it no longer points
   * to `parent`: nothing is written then.
   */
  abstract commit(
    name: string,
    request: {
      readonly parent: string;
      readonly tree: string;
      readonly message: string;
      readonly author: ChangeSetAuthor;
      readonly changeSetId: string;
      readonly carried?: readonly ChangeSetAuthor[];
    },
  ): Promise<{ commit: string } | { moved: string | undefined }>;

  /**
   * Up to `max` commits of the branch `name`'s first-parent history from
   * `head` (newest first, `head` itself first), with their first parent,
   * how many parents they have and their tree. Nothing a commit says
   * about itself (trailers, author) is read: whoever can push can write
   * those.
   */
  abstract history(
    name: string,
    head: string,
    max: number,
    /**
     * Leaves out the commits in this commit's history (the change set's
     * base commit, say): what is left is the branch's own line.
     */
    excluding?: string,
  ): Promise<BranchCommit[]>;

  /**
   * Who wrote the commits of `head`'s first-parent history on the branch
   * `name`, leaving out `excluding`'s history (the change set's base commit):
   * for four eyes and the self-approval rule (#597), never to grant anything.
   * A commit counts when it is one the API wrote (`commit`): the actor its
   * last `Actor` trailer names, if its Git author is that actor's identity,
   * and each actor its `Carried-author` trailers name. Any other commit (a
   * push from outside the API, an import, an update from the base) names
   * nobody. Each actor once, in the order found; 409 `too-many-commits` when
   * the line is longer than `MAX_WRITER_COMMITS` (it could not be read
   * whole).
   */
  abstract writers(
    name: string,
    head: string,
    excluding: string,
  ): Promise<ChangeSetAuthor[]>;

  /**
   * The files that differ between `from` and `to` (any two commits, for
   * a commit usually its parent), with whether `to` lacks them. Rejects
   * when either is not a commit of the repository.
   */
  abstract changedPaths(
    from: string,
    to: string,
  ): Promise<{ path: string; deleted: boolean }[]>;

  /**
   * What merging `head` into `expected` would hold at `paths` (each a
   * content file's path), without committing or moving a ref: the bytes,
   * `null` where the merge holds no file; `'conflicts'` when it would
   * conflict. For checking the tree a merge makes before making it.
   */
  abstract mergedFiles(
    expected: string,
    head: string,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, Uint8Array | null> | 'conflicts'>;

  /**
   * Applies the change `from` → `to` (a change set's base commit and its
   * merged head) onto the commit `onto` (another branch's head), writing
   * no commit and moving no ref: a three-way merge with `from` as its
   * base, so nothing before `from` comes along (#60, carrying a fix
   * forward). `files` holds, at each of `paths` that applies cleanly and
   * differs from `onto`, the result's bytes (`null`: no file there);
   * `conflicts` the paths that do not apply (git's conflict kinds, or
   * `unsupported` for a path no commit may write), never resolved and
   * never in `files`.
   */
  abstract applyChange(request: {
    readonly from: string;
    readonly to: string;
    readonly onto: string;
    readonly paths: readonly string[];
  }): Promise<{
    readonly files: ReadonlyMap<string, Uint8Array | null>;
    readonly conflicts: readonly MergeConflictPath[];
  }>;

  /**
   * Merges the commit `head` (a change set's, exactly as approved) into
   * the branch `into` (never a change-set branch), moving `into` from
   * `expected` by compare-and-swap. A merge commit has parents `expected`
   * and `head`, `actor` as its author and committer, and trailers naming
   * the change set (`Merged-change-set`), the actor (`Merged-by`) and each
   * of `approvedBy` (`Approved-by`): never the `Change-set` and `Actor`
   * trailers of a save point, so no recovery of save points can read a
   * merge commit as one.
   * `fastForward: 'allow'` (the default) moves `into` to `head` when that
   * is a fast-forward, recording no merge commit and so no trailers;
   * `'never'` always records one, and so does any merge with `approvedBy`. Nothing is written for `moved` (where
   * `into` is now; retry on top of it), `conflicts` (never resolved
   * automatically) and `up-to-date`. A message that can never be used is
   * an `UnprocessableError`; histories with nothing in common a
   * `ConflictError` (`unrelated-histories`).
   */
  /**
   * Where the branch `name` (any branch: a change set's or a merge target)
   * points; undefined when there is no such branch.
   */
  abstract head(name: string): Promise<string | undefined>;

  /** Whether `commit` is in the history of the branch `into` (false: no such branch). */
  abstract contains(into: string, commit: string): Promise<boolean>;

  /**
   * Whether `head` is in the history of the branch `into`: a merge of it
   * landed (or `into` took it in some other way). Undefined when it is not.
   * Otherwise `commit` is the merge commit for change set `changeSetId`
   * among `into`'s first-parent commits since `head`'s history (every one
   * the base gained since; undefined when none is found there), with `mergedBy` from its `Merged-by` trailer when its Git
   * author is the identity this port writes for that actor.
   */
  abstract mergedInto(
    into: string,
    head: string,
    changeSetId: string,
  ): Promise<
    | { commit: string | undefined; mergedBy: ChangeSetAuthor | undefined }
    | undefined
  >;

  /**
   * What `refresh` would do, writing no commit and moving no ref: `base`
   * (the base branch's head) already in the history of `expected` (the
   * change set's branch head), the files a clean merge changes on the
   * branch, or the conflicts left once those at `keep` are resolved to the
   * branch's file. Histories with nothing in common are a `ConflictError`
   * (`unrelated-histories`).
   */
  abstract previewRefresh(request: {
    readonly expected: string;
    readonly base: string;
    readonly keep: readonly string[];
  }): Promise<RefreshPreview>;

  /**
   * Brings the change-set branch `name` up to date with `base`, the
   * commit its base branch points to (#22): a fast-forward when the branch
   * has no commits of its own, else a merge commit with parents `expected`
   * and `base`, `actor` as its author and committer and trailers naming
   * the change set (`Updated-change-set`) and the actor (`Updated-by`),
   * never a save point's or a merge's. A conflict at one of `keep` (a
   * plain file conflict) keeps the branch's file. The branch moves from
   * `expected` by compare-and-swap; nothing is written for `moved`,
   * `conflicts` (those `keep` does not resolve) and `up-to-date`.
   */
  abstract refresh(
    name: string,
    request: {
      readonly expected: string;
      readonly base: string;
      readonly keep: readonly string[];
      readonly message: string;
      readonly actor: ChangeSetAuthor;
      readonly changeSetId: string;
    },
  ): Promise<BranchRefresh>;

  /**
   * How many commits `base` has that `head` does not (how far a change
   * set's branch is behind its base), counting no further than
   * `MAX_BEHIND`.
   */
  abstract behind(head: string, base: string): Promise<number>;

  abstract merge(request: {
    readonly into: string;
    readonly expected: string;
    readonly head: string;
    readonly message: string;
    readonly actor: ChangeSetAuthor;
    readonly changeSetId: string;
    readonly approvedBy?: readonly ChangeSetAuthor[];
    readonly fastForward?: 'allow' | 'never';
  }): Promise<BranchMerge>;
}

/** What `ChangeSetBranches.merge` did. */
export type BranchMerge =
  /** `into` is now at `commit`: a merge commit, or `head` on a fast-forward. */
  | {
      readonly kind: 'merged';
      readonly commit: string;
      readonly fastForward: boolean;
    }
  /** `head` was already in the history of `into`, at `commit`. */
  | { readonly kind: 'up-to-date'; readonly commit: string }
  /** `into` no longer points to `expected`: it is at `head` (undefined: gone). */
  | { readonly kind: 'moved'; readonly head: string | undefined }
  /** The paths git could not merge, with the kinds of conflict. */
  | {
      readonly kind: 'conflicts';
      readonly conflicts: readonly MergeConflictPath[];
    };

/** The most commits `ChangeSetBranches.behind` counts. */
export const MAX_BEHIND = 1000;

/** What `ChangeSetBranches.previewRefresh` found. */
export type RefreshPreview =
  | { readonly kind: 'up-to-date' }
  | {
      readonly kind: 'clean';
      readonly fastForward: boolean;
      /** The files the update changes on the branch. */
      readonly changed: readonly { path: string; deleted: boolean }[];
    }
  | {
      readonly kind: 'conflicts';
      readonly conflicts: readonly MergeConflictPath[];
    };

/** What `ChangeSetBranches.refresh` did. */
export type BranchRefresh =
  /** The branch is now at `commit`: a merge commit, or `base` on a fast-forward. */
  | {
      readonly kind: 'merged';
      readonly commit: string;
      readonly fastForward: boolean;
    }
  /** `base` was in the branch's history already. */
  | { readonly kind: 'up-to-date' }
  /** The branch no longer points to `expected`: it is at `head` (undefined: gone). */
  | { readonly kind: 'moved'; readonly head: string | undefined }
  /** The paths left conflicting, with the kinds of conflict. */
  | {
      readonly kind: 'conflicts';
      readonly conflicts: readonly MergeConflictPath[];
    };

/** A path a merge conflicts in (`contents`, `modify/delete`, … as git names them). */
export interface MergeConflictPath {
  readonly path: string;
  readonly kinds: readonly string[];
}

/** A commit in a change-set branch's history (`ChangeSetBranches.history`). */
export interface BranchCommit {
  readonly commit: string;
  /** Its first parent; undefined for a root commit. */
  readonly parent?: string;
  /** How many parents it has (2 or more: a merge). */
  readonly parents: number;
  readonly tree: string;
}
