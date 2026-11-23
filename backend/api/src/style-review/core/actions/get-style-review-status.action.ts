import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { StyleReviewer } from '../style-reviewer.js';

export interface GetStyleReviewStatusInput {
  readonly actor: Actor;
}

/** Whether this server has a style review, for a client to offer it (#247). */
export interface StyleReviewStatus {
  readonly configured: boolean;
}

/**
 * Whether the model-based style review (#248) is set up on this server, so the editor offers
 * "Review style" only where it works (#247). Says nothing else about the reviewer (no address, no
 * model). For those who may ask for a review: `content.edit`.
 */
@Injectable()
export class GetStyleReviewStatusAction extends ActorAction<
  GetStyleReviewStatusInput,
  StyleReviewStatus
> {
  readonly policy = 'content.edit';

  constructor(private readonly reviewer: StyleReviewer) {
    super();
  }

  protected run(): Promise<StyleReviewStatus> {
    return Promise.resolve({ configured: this.reviewer.configured });
  }
}
