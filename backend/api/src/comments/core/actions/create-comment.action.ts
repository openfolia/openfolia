import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { ChangeSetStore } from '../../../change-sets/core/change-set-store.js';
import {
  type CommentSubject,
  isThread,
  MAX_COMMENTS,
  moduleKey,
  newCommentId,
  type ReadComment,
} from '../comment.js';
import { CommentStore } from '../comment-store.js';
import { ChangeSetComments, checkOpen } from '../change-set-comments.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

/** What a new comment is on: a block (a new thread), or a thread it replies to. */
export type NewCommentAnchor =
  | { readonly subject: CommentSubject; readonly blockId: string }
  | { readonly threadId: string };

interface Input {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly body: string;
  readonly anchor: NewCommentAnchor;
}

/** The 403's detail: one answer, whatever the reason. */
export const MAY_NOT_COMMENT =
  'Only the change set’s author, or a reviewer (content.review) whose role covers the module, may comment on it.';

/**
 * Writes a comment on an open change set: a new thread on a block of a
 * module (one the reader sees, holding the block at the head or at the
 * base: else 422 `block-not-found`, a hidden module and a missing one
 * alike), or a reply to a thread (its first comment: else 422
 * `invalid-thread`), on the thread's anchor. Only the change set's author
 * or a reviewer (`content.review`) whose role covers the module (else 403).
 * In one transaction that holds the change set's row (so it is still open:
 * 409 `invalid-state`, and its comments are counted: at most
 * `MAX_COMMENTS`, 409 `too-many-comments`), with a `comment.create` audit
 * event.
 */
@Injectable()
export class CreateCommentAction extends ActorAction<Input, ReadComment> {
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
    body,
    anchor,
  }: Input): Promise<ReadComment> {
    this.sandbox.checkCommentLength(body);
    const opened = await this.comments.open(actor, changeSetId);
    const { changeSet, anchors } = opened;
    let subject: CommentSubject;
    let blockId: string;
    let threadId: string | undefined;
    if ('threadId' in anchor) {
      const thread = await this.comments
        .comment(opened, anchor.threadId)
        .catch((error: unknown) => {
          if (error instanceof NotFoundError) return undefined;
          throw error;
        });
      if (!thread || !isThread(thread)) {
        throw unprocessable(
          'invalid-thread',
          `No thread "${anchor.threadId}" to reply to in this change set: a reply goes to a thread's first comment.`,
          '/data/relationships/thread/data/id',
        );
      }
      ({ subject, blockId } = thread);
      threadId = thread.id;
    } else {
      ({ subject, blockId } = anchor);
      if (
        !(await anchors.sees(subject)) ||
        !(await anchors.hasBlock(subject, blockId))
      ) {
        throw unprocessable(
          'block-not-found',
          `No block "${blockId}" in the module ${moduleKey(subject)} of this change set.`,
          '/data/attributes/blockId',
        );
      }
    }
    if (!(await anchors.mayWrite(subject))) {
      throw new ForbiddenError(MAY_NOT_COMMENT);
    }
    const id = newCommentId();
    const comment = await this.unit.run(async (tx) => {
      const current = await this.changeSets.lock(tx, changeSet.id);
      if (!current) throw new NotFoundError(`No change set "${changeSetId}".`);
      checkOpen(current);
      // Deleted meanwhile (its author's, as the change set's row was not
      // held yet): no thread to reply to any more.
      if (threadId !== undefined && !(await this.store.lock(tx, threadId))) {
        throw unprocessable(
          'invalid-thread',
          `No thread "${threadId}" to reply to in this change set: it was deleted.`,
          '/data/relationships/thread/data/id',
        );
      }
      if ((await this.store.count(tx, changeSet.id)) >= MAX_COMMENTS) {
        throw new ConflictError(
          'too-many-comments',
          `A change set holds at most ${MAX_COMMENTS} comments.`,
          { max: MAX_COMMENTS },
        );
      }
      const written = await this.store.insert(tx, {
        id,
        changeSetId: changeSet.id,
        threadId: threadId ?? id,
        subject,
        blockId,
        commit: anchors.sides.head.commit,
        author: { kind: actor.kind, id: actor.id },
        body,
      });
      await this.auditLog.record(tx, actor, {
        action: 'comment.create',
        subject: { type: 'comment', id },
        data: {
          changeSetId: changeSet.id,
          module: moduleKey(subject),
          blockId,
          commit: written.commit,
          ...(threadId !== undefined && { threadId }),
        },
      });
      return written;
    }, BOUNDED);
    return {
      comment,
      orphaned: await anchors.orphaned(subject, blockId),
    };
  }
}

/** A 422 with `code`, its detail and a pointer to the body member at fault. */
function unprocessable(
  code: string,
  detail: string,
  pointer: string,
): UnprocessableProblems {
  return new UnprocessableProblems(code, detail, [{ detail, pointer }]);
}
