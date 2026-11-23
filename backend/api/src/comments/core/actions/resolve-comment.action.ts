import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetStore } from '../../../change-sets/core/change-set-store.js';
import { isThread, type ReadComment } from '../comment.js';
import { CommentStore } from '../comment-store.js';
import { ChangeSetComments, checkOpen } from '../change-set-comments.js';
import { MAY_NOT_COMMENT } from './create-comment.action.js';

interface Input {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly commentId: string;
}

/** Resolving or reopening a thread: the one rule both follow. */
@Injectable()
abstract class ThreadResolutionAction extends ActorAction<Input, ReadComment> {
  readonly policy = 'content.read';
  protected abstract readonly resolve: boolean;

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
  }: Input): Promise<ReadComment> {
    const opened = await this.comments.open(actor, changeSetId);
    const found = await this.comments.comment(opened, commentId);
    if (!(await opened.anchors.mayWrite(found.subject))) {
      throw new ForbiddenError(MAY_NOT_COMMENT);
    }
    if (!isThread(found)) {
      throw new UnprocessableError(
        'not-a-thread',
        `The comment is a reply; resolve or reopen its thread ("${found.threadId}").`,
        { threadId: found.threadId },
      );
    }
    const action = this.resolve ? 'comment.resolve' : 'comment.reopen';
    const comment = await this.unit.run(async (tx) => {
      const changeSet = await this.changeSets.lock(tx, opened.changeSet.id);
      if (!changeSet)
        throw new NotFoundError(`No change set "${changeSetId}".`);
      checkOpen(changeSet);
      const current = await this.store.lock(tx, found.id);
      if (!current) throw new NotFoundError(`No comment "${commentId}".`);
      if ((current.resolution !== undefined) === this.resolve) {
        throw new ConflictError(
          this.resolve ? 'already-resolved' : 'not-resolved',
          this.resolve
            ? 'The thread is resolved already.'
            : 'The thread is not resolved.',
        );
      }
      const changed = await this.store.setResolution(
        tx,
        current.id,
        this.resolve ? { kind: actor.kind, id: actor.id } : null,
      );
      await this.auditLog.record(tx, actor, {
        action,
        subject: { type: 'comment', id: current.id },
        data: { changeSetId: changeSet.id },
      });
      return changed;
    }, BOUNDED);
    return {
      comment,
      orphaned: await opened.anchors.orphaned(comment.subject, comment.blockId),
    };
  }
}

/**
 * Resolves a thread (its first comment) of an open change set: who may
 * comment on its module may resolve it (the change set's author, or a
 * reviewer whose `content.review` role covers the module). A reply is 422
 * `not-a-thread`; a resolved thread 409 `already-resolved`. The comments
 * stay stored; lists hide resolved threads unless asked
 * (`filter[resolved]`). With a `comment.resolve` audit event, in one
 * transaction holding the change set's row and the comment's.
 */
@Injectable()
export class ResolveCommentAction extends ThreadResolutionAction {
  protected readonly resolve = true;
}

/** Reopens a resolved thread, as `ResolveCommentAction` resolves one (409 `not-resolved` for an open one; `comment.reopen`). */
@Injectable()
export class ReopenCommentAction extends ThreadResolutionAction {
  protected readonly resolve = false;
}
