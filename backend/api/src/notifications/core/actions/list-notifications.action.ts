import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { Notification } from '../notification.js';
import { NotificationStore, type UnreadState } from '../notification-store.js';

/**
 * Whose notifications `actor` reads: their own, as a user. A service (the
 * API token) has none.
 */
export function recipientOf(actor: Actor): string | undefined {
  return actor.kind === 'user' ? actor.id : undefined;
}

export interface ListNotificationsInput {
  readonly actor: Actor;
  readonly filter: { readonly unread?: boolean };
  readonly page: PageRequest;
}

/**
 * The actor's own notifications, newest first, with their unread count.
 * Any actor; nobody reads another's (`recipientOf`).
 */
@Injectable()
export class ListNotificationsAction extends ActorAction<
  ListNotificationsInput,
  Paginated<Notification> & { unreadCount: number }
> {
  readonly policy = 'any-actor';

  constructor(private readonly store: NotificationStore) {
    super();
  }

  protected async run({
    actor,
    filter,
    page,
  }: ListNotificationsInput): Promise<
    Paginated<Notification> & { unreadCount: number }
  > {
    const recipient = recipientOf(actor);
    if (recipient === undefined) return { items: [], total: 0, unreadCount: 0 };
    return this.store.list(recipient, filter, page);
  }
}

/**
 * One of the actor's own notifications; another's is 404, exactly like
 * one that does not exist.
 */
@Injectable()
export class GetNotificationAction extends ActorAction<
  { readonly actor: Actor; readonly id: string },
  Notification
> {
  readonly policy = 'any-actor';

  constructor(private readonly store: NotificationStore) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    readonly actor: Actor;
    readonly id: string;
  }): Promise<Notification> {
    const recipient = recipientOf(actor);
    const found =
      recipient === undefined
        ? undefined
        : await this.store.find(recipient, id);
    if (!found) throw new NotFoundError(`No notification "${id}".`);
    return found;
  }
}

/** How many of the actor's own notifications are unread, and the newest one, for the bell. */
@Injectable()
export class CountUnreadNotificationsAction extends ActorAction<
  { readonly actor: Actor },
  UnreadState
> {
  readonly policy = 'any-actor';

  constructor(private readonly store: NotificationStore) {
    super();
  }

  protected async run({
    actor,
  }: {
    readonly actor: Actor;
  }): Promise<UnreadState> {
    const recipient = recipientOf(actor);
    if (recipient === undefined) return { count: 0, latest: undefined };
    return this.store.unread(recipient);
  }
}
