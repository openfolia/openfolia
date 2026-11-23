import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { AuthoredBranches } from '../authored-branches.js';
import { ChangeSetBranchMissingError } from '../change-set-branch-missing.js';
import { ContentRepository, type RefInfo } from '../content.repository.js';
import { type ReadPermission, ReadableContent } from '../readable-content.js';
import { readPermissionAt } from '../released.js';

export interface OpenSnapshotInput {
  readonly actor: Actor;
  /** A branch, tag or commit. */
  readonly ref: string;
  /**
   * Given only by an action that has decided, under the change set's row
   * lock, whether `ref` is the branch of a change set that opens for
   * `actor` as its author (`opensAsAuthor`): that answer is used and
   * `AuthoredBranches` is not asked (inside that transaction a second
   * query could wait for it forever). Never from a request.
   */
  readonly authored?: boolean;
  /**
   * Given only by an action that has checked that `ref` is, by its full
   * commit ID, the base commit of a change set that opens for `actor` as
   * its author (`opensAsAuthor`: it started from released content), to
   * show the author what their own change set changes (#23, #126): read
   * through their `content.read` scope, as it was released content when
   * the change set started (their branch holds all of it but what they
   * changed). Never from a request.
   */
  readonly authoredBase?: boolean;
  /**
   * Given only by an action that has checked that `ref` is, by its full
   * commit ID, a commit it recorded as released content when it recorded
   * it (a translation job's, #50): read through the actor's `content.read`
   * scope, as the released content it was, even once `main` has moved on.
   * Never from a request.
   */
  readonly releasedOnce?: boolean;
}

/**
 * The content at a branch, tag or commit, as the actor may read it
 * (`ReadableContent`). The permission is checked before the repository is
 * opened, so an actor who may not read learns nothing about which refs
 * exist. A ref whose commit is not released also needs
 * `content.read.draft` (`readPermissionAt`); without it, it is not found,
 * exactly like a ref that does not exist. One exception: authors always
 * see their own work (#126), so a change set's branch, named exactly,
 * opens for its author without `content.read.draft`, read through their
 * `content.read` scope as a released ref is (`AuthoredBranches`). That
 * names the branch, never a commit of it by ID.
 */
@Injectable()
export class OpenSnapshotAction extends ActorAction<
  OpenSnapshotInput,
  ReadableContent
> {
  readonly policy = 'content.read';

  constructor(
    private readonly content: ContentRepository,
    private readonly authored: AuthoredBranches,
  ) {
    super();
  }

  protected async run({
    actor,
    ref,
    authored,
    authoredBase,
    releasedOnce,
  }: OpenSnapshotInput): Promise<ReadableContent> {
    const notFound = () =>
      new NotFoundError(`No branch, tag or commit "${ref}".`);
    const [snapshot, refs] = await Promise.all([
      this.content.at(ref),
      this.content.refs(),
    ]);
    if (!snapshot) throw await this.missing(actor, ref, authored, notFound);
    const permission =
      // Before the draft rule, so a job's file reads through `content.read`
      // even for a holder of a (narrower) `content.read.draft`.
      (releasedOnce && snapshot.commit === ref ? 'content.read' : undefined) ??
      readPermissionAt(actor, snapshot.commit, refs) ??
      (authoredBase && snapshot.commit === ref ? 'content.read' : undefined) ??
      (await this.authoredPermission(
        actor,
        ref,
        snapshot.commit,
        refs.branches,
        authored,
      ));
    if (!permission) throw notFound();
    return new ReadableContent(snapshot, actor, permission);
  }

  /**
   * Why `ref` did not resolve: a change set's branch that is gone, for a
   * reader who may see that change set (`authored`, when the caller has
   * decided it under the change set's row lock, else
   * `AuthoredBranches.visibleChangeSet`); not found for anything else.
   */
  private async missing(
    actor: Actor,
    ref: string,
    known: boolean | undefined,
    notFound: () => NotFoundError,
  ): Promise<NotFoundError> {
    const visible = known ?? (await this.authored.visibleChangeSet(actor, ref));
    return visible ? new ChangeSetBranchMissingError(ref) : notFound();
  }

  /**
   * `content.read` when `ref` is exactly the name of a branch the actor
   * authors and `commit`, what it resolved to, is that branch's head
   * (not a commit that happens to share the name); else undefined.
   */
  private async authoredPermission(
    actor: Actor,
    ref: string,
    commit: string,
    branches: readonly RefInfo[],
    known: boolean | undefined,
  ): Promise<ReadPermission | undefined> {
    const branch = branches.find((b) => b.name === ref);
    if (branch?.commit !== commit) return undefined;
    return (known ?? (await this.authored.authoredBy(actor, ref)))
      ? 'content.read'
      : undefined;
  }
}
