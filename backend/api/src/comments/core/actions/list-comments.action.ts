import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { CommentFilter, ReadComment } from '../comment.js';
import type { CommentAnchors } from '../comment-anchors.js';
import { CommentStore } from '../comment-store.js';
import { ChangeSetComments } from '../change-set-comments.js';

interface Input {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly filter: Omit<CommentFilter, 'modules'>;
  readonly page: PageRequest;
}

/** One page of a change set's comments, and the head they were checked against. */
export interface CommentPage extends Paginated<ReadComment> {
  /** The change set's head (the review head once submitted): what `orphaned` is of. */
  readonly head: string;
}

/**
 * One page of a change set's comments, in thread order (threads by when
 * they were started, each followed by its replies), each with whether its
 * block is gone from the head (`orphaned`). Only comments on modules the
 * reader may see (`CommentAnchors.sees`), filtered before paging, so the
 * total counts only those. The change set is found as
 * `GetChangeSetAction` finds it.
 */
@Injectable()
export class ListCommentsAction extends ActorAction<Input, CommentPage> {
  readonly policy = 'content.read';

  constructor(
    private readonly comments: ChangeSetComments,
    private readonly store: CommentStore,
  ) {
    super();
  }

  protected async run({
    actor,
    changeSetId,
    filter,
    page,
  }: Input): Promise<CommentPage> {
    const opened = await this.comments.open(actor, changeSetId);
    const { anchors } = opened;
    let modules: CommentFilter['modules'];
    if (filter.module !== undefined) {
      if (!(await anchors.sees(filter.module))) {
        return { total: 0, items: [], head: anchors.sides.head.commit };
      }
    } else if (!anchors.seesAll()) {
      modules = await anchors.visible(
        await this.store.modules(opened.changeSet.id),
      );
    }
    const found = await this.store.list(
      opened.changeSet.id,
      { ...filter, ...(modules !== undefined && { modules }) },
      page,
    );
    return {
      total: found.total,
      items: await readAll(anchors, found.items),
      head: anchors.sides.head.commit,
    };
  }
}

/** `comments` with whether each is orphaned. */
export async function readAll(
  anchors: CommentAnchors,
  comments: Paginated<ReadComment['comment']>['items'],
): Promise<ReadComment[]> {
  return Promise.all(
    comments.map(async (comment) => ({
      comment,
      orphaned: await anchors.orphaned(comment.subject, comment.blockId),
    })),
  );
}
