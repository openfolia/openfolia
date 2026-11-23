import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { ReadComment } from '../comment.js';
import { ChangeSetComments } from '../change-set-comments.js';

interface Input {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly commentId: string;
}

/**
 * One comment of a change set, with whether it is orphaned. 404 for a
 * comment that is not there, is another change set's, or lies on a module
 * the reader may not see, answered alike.
 */
@Injectable()
export class GetCommentAction extends ActorAction<Input, ReadComment> {
  readonly policy = 'content.read';

  constructor(private readonly comments: ChangeSetComments) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    commentId,
  }: Input): Promise<ReadComment> {
    const opened = await this.comments.open(actor, changeSetId);
    const comment = await this.comments.comment(opened, commentId);
    return {
      comment,
      orphaned: await opened.anchors.orphaned(comment.subject, comment.blockId),
    };
  }
}
