import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetStore } from '../../../change-sets/core/change-set-store.js';
import { isThread } from '../comment.js';
import { CommentStore } from '../comment-store.js';
import {
  ChangeSetComments,
  checkNotDeleted,
  checkOpen,
  checkOwnComment,
} from '../change-set-comments.js';

interface Input {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly commentId: string;
}

/** What deleting a comment did. */
export interface DeletedComment {
  /**
   * The comment stays as "deleted", without its text: a thread's first
   * comment with replies, so the thread stays readable. Else it is gone.
   */
  readonly kept: boolean;
}

/**
 * Deletes one's own comment on an open change set (#268), its author only,
 * as `EditCommentAction` decides (403 for anyone else who sees it, 404 for
 * anyone who does not; 409 `comment-deleted`, `invalid-state`). A thread's
 * first comment with replies stays, its text removed (`deletedAt`); a reply,
 * or a thread without replies, is removed. A reply that was the last one
 * of a deleted thread takes the thread's first comment with it, so nothing
 * but "deleted" is left of it. The text is gone for good (the audit log
 * never held it); a `comment.delete` event records that it was deleted. In
 * one transaction holding the change set's row (so no reply is written
 * meanwhile) and the comment's.
 */
@Injectable()
export class DeleteCommentAction extends ActorAction<Input, DeletedComment> {
  readonly policy = 'content.read';

  constructor(
    private readonly comments: ChangeSetComments,
    private readonly store: CommentStore,
    private readonly changeSets: ChangeSetStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    commentId,
  }: Input): Promise<DeletedComment> {
    const opened = await this.comments.open(actor, changeSetId);
    const found = await this.comments.comment(opened, commentId);
    await checkOwnComment(opened, actor, found);
    return this.unit.run(async (tx) => {
      const changeSet = await this.changeSets.lock(tx, opened.changeSet.id);
      if (!changeSet)
        throw new NotFoundError(`No change set "${changeSetId}".`);
      checkOpen(changeSet);
      const current = await this.store.lock(tx, found.id);
      if (!current) throw new NotFoundError(`No comment "${commentId}".`);
      checkNotDeleted(current);
      let kept = false;
      let threadRemoved = false;
      if (isThread(current)) {
        kept = (await this.store.replies(tx, current.id)) > 0;
        if (kept) await this.store.markDeleted(tx, current.id);
        else await this.store.remove(tx, current.id);
      } else {
        await this.store.remove(tx, current.id);
        const thread = await this.store.lock(tx, current.threadId);
        if (
          thread?.deletedAt !== undefined &&
          (await this.store.replies(tx, thread.id)) === 0
        ) {
          await this.store.remove(tx, thread.id);
          threadRemoved = true;
        }
      }
      await this.auditLog.record(tx, actor, {
        action: 'comment.delete',
        subject: { type: 'comment', id: current.id },
        data: {
          changeSetId: changeSet.id,
          ...(!isThread(current) && { threadId: current.threadId }),
          kept,
          ...(threadRemoved && { threadRemoved }),
        },
      });
      return { kept };
    }, BOUNDED);
  }
}
