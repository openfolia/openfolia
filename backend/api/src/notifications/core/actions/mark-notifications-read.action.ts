import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { NotificationStore } from '../notification-store.js';
import { recipientOf } from './list-notifications.action.js';

export interface MarkNotificationsReadInput {
  readonly actor: Actor;
  /** The notifications to mark read (at most `MAX_MARKED`), or all of the actor's. */
  readonly ids: readonly string[] | 'all';
}

/**
 * Marks the actor's own notifications read: the ones named, or all.
 * Named ones that are not the actor's (another person's, or none at all)
 * are 404, answered alike, and nothing is marked. One already read keeps
 * the time it was read. Answers how many it marked and how many are
 * still unread.
 */
@Injectable()
export class MarkNotificationsReadAction extends ActorAction<
  MarkNotificationsReadInput,
  { marked: number; unreadCount: number }
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly store: NotificationStore,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({ actor, ids }: MarkNotificationsReadInput): Promise<{
    marked: number;
    unreadCount: number;
  }> {
    const recipient = recipientOf(actor);
    if (recipient === undefined) {
      if (ids === 'all') return { marked: 0, unreadCount: 0 };
      throw new NotFoundError(`No notification "${ids[0] ?? ''}".`);
    }
    const marked = await this.unit.run(async (tx) => {
      if (ids !== 'all') {
        const owned = await this.store.owned(tx, recipient, ids);
        const missing = ids.find((id) => !owned.has(id));
        if (missing !== undefined) {
          throw new NotFoundError(`No notification "${missing}".`);
        }
      }
      return this.store.markRead(tx, recipient, ids);
    }, BOUNDED);
    const { count } = await this.store.unread(recipient);
    return { marked, unreadCount: count };
  }
}
