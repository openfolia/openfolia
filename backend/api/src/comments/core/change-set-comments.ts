import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../base/core/errors.js';
import { GetChangeSetAction } from '../../change-sets/core/actions/get-change-set.action.js';
import {
  type ChangeSet,
  OPEN_STATES,
} from '../../change-sets/core/change-set.js';
import { ChangeSetBranches } from '../../change-sets/core/change-set-branches.js';
import { openSides } from '../../change-sets/core/change-set-sides.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import { type Comment, isAuthor } from './comment.js';
import { CommentAnchors } from './comment-anchors.js';
import { CommentStore } from './comment-store.js';

/** A change set as its comments are read and written: with its anchors. */
export interface OpenedComments {
  readonly changeSet: ChangeSet;
  readonly anchors: CommentAnchors;
}

/**
 * Opens a change set for its comments: found as `GET /change-sets/:id`
 * finds it (another author's is 404 for an actor without
 * `content.read.draft`, exactly like a missing one), with its base and
 * head as the actor may read them (`openSides`).
 */
@Injectable()
export class ChangeSetComments {
  constructor(
    private readonly getChangeSet: GetChangeSetAction,
    private readonly branches: ChangeSetBranches,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly store: CommentStore,
  ) {}

  async open(actor: Actor, changeSetId: string): Promise<OpenedComments> {
    const changeSet = await this.getChangeSet.handle({
      actor,
      id: changeSetId,
    });
    const sides = await openSides(
      this.branches,
      this.openSnapshot,
      actor,
      changeSet,
    );
    return { changeSet, anchors: new CommentAnchors(actor, changeSet, sides) };
  }

  /**
   * The comment `commentId` of the opened change set, when the actor may
   * see it; else 404, exactly like a missing one.
   */
  async comment(
    { changeSet, anchors }: OpenedComments,
    commentId: string,
  ): Promise<Comment> {
    const comment = await this.store.find(commentId);
    if (
      !comment ||
      comment.changeSetId !== changeSet.id ||
      !(await anchors.sees(comment.subject))
    ) {
      throw new NotFoundError(`No comment "${commentId}".`);
    }
    return comment;
  }
}

/** 409 `invalid-state` unless `changeSet` is open: comments are written only on open change sets. */
export function checkOpen(changeSet: ChangeSet): void {
  if (!OPEN_STATES.includes(changeSet.state)) {
    throw new ConflictError(
      'invalid-state',
      `The change set is ${changeSet.state}; comments are written only on an open one.`,
      { state: changeSet.state },
    );
  }
}

/** The 403's detail for editing or deleting a comment: one answer, whatever the reason. */
export const ONLY_ITS_AUTHOR =
  'Only its author, while they may comment on its module, may edit or delete a comment.';

/**
 * Who may edit or delete `comment` (one the actor sees): its author, while
 * they may still comment on its module (else 403, one answer whatever the
 * reason); a comment already deleted is 409 `comment-deleted`.
 */
export async function checkOwnComment(
  { anchors }: OpenedComments,
  actor: Actor,
  comment: Comment,
): Promise<void> {
  if (!isAuthor(comment, actor) || !(await anchors.mayWrite(comment.subject))) {
    throw new ForbiddenError(ONLY_ITS_AUTHOR);
  }
  checkNotDeleted(comment);
}

/** 409 `comment-deleted` for a comment deleted already. */
export function checkNotDeleted(comment: Comment): void {
  if (comment.deletedAt !== undefined) {
    throw new ConflictError('comment-deleted', 'The comment is deleted.');
  }
}
