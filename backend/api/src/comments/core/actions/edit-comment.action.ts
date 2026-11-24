import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError, NotFoundError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetStore } from '../../../change-sets/core/change-set-store.js';
import type { ReadComment } from '../comment.js';
import { CommentStore } from '../comment-store.js';
import {
  ChangeSetComments,
  checkNotDeleted,
  checkOpen,
  checkOwnComment,
} from '../change-set-comments.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

interface Input {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly commentId: string;
  /** The ID the request's resource object names: must be `commentId`. */
  readonly resourceId?: string;
  readonly body: string;
}

/**
 * Changes the text of one's own comment on an open change set (#268): its
 * author only, while they may comment on its module (403 for anyone else
 * who sees it; 404, exactly like a missing one, for anyone who does not).
 * The comment stays where it is (its anchor, thread and resolution) and is
 * marked edited (`editedAt`). The old text is not kept anywhere: the audit
 * log never holds a comment's text, so a `comment.edit` event records only
 * that, when and by whom. A text that is the same changes nothing and is
 * not audited. A deleted comment is 409 `comment-deleted`; a change set no
 * longer open 409 `invalid-state`. In one transaction holding the change
 * set's row and the comment's.
 */
@Injectable()
export class EditCommentAction extends ActorAction<Input, ReadComment> {
  readonly policy = 'content.read';

  constructor(
    private readonly comments: ChangeSetComments,
    private readonly store: CommentStore,
    private readonly changeSets: ChangeSetStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    commentId,
    resourceId,
    body,
  }: Input): Promise<ReadComment> {
    this.sandbox.checkCommentLength(body);
    if (resourceId !== undefined && resourceId !== commentId) {
      throw new ConflictError(
        'id-mismatch',
        'The resource object’s `id` is not the comment in the path.',
      );
    }
    const opened = await this.comments.open(actor, changeSetId);
    const found = await this.comments.comment(opened, commentId);
    await checkOwnComment(opened, actor, found);
    const comment = await this.unit.run(async (tx) => {
      const changeSet = await this.changeSets.lock(tx, opened.changeSet.id);
      if (!changeSet)
        throw new NotFoundError(`No change set "${changeSetId}".`);
      checkOpen(changeSet);
      const current = await this.store.lock(tx, found.id);
      if (!current) throw new NotFoundError(`No comment "${commentId}".`);
      checkNotDeleted(current);
      if (current.body === body) return current;
      const edited = await this.store.edit(tx, current.id, body);
      await this.auditLog.record(tx, actor, {
        action: 'comment.edit',
        subject: { type: 'comment', id: current.id },
        data: { changeSetId: changeSet.id },
      });
      return edited;
    }, BOUNDED);
    return {
      comment,
      orphaned: await opened.anchors.orphaned(comment.subject, comment.blockId),
    };
  }
}
