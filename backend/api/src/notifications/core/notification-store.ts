import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { NewNotification, Notification } from './notification.js';

/** Where a recipient's unread notifications stand, for the bell. */
export interface UnreadState {
  readonly count: number;
  /** The newest notification's ID, read or not; undefined when there is none. */
  readonly latest: string | undefined;
}

/**
 * Port: the notifications, per recipient. Every read and write names its
 * recipient, so no path reads or marks another person's notifications.
 */
export abstract class NotificationStore {
  /** One page of `recipient`'s notifications, newest first, and their unread count. */
  abstract list(
    recipient: string,
    filter: { readonly unread?: boolean },
    page: PageRequest,
  ): Promise<Paginated<Notification> & { unreadCount: number }>;

  /** One of `recipient`'s notifications; undefined for any other ID. */
  abstract find(
    recipient: string,
    id: string,
  ): Promise<Notification | undefined>;

  abstract unread(recipient: string): Promise<UnreadState>;

  /** Of `ids`, those that are `recipient`'s notifications, inside `tx`. */
  abstract owned(
    tx: Transaction,
    recipient: string,
    ids: readonly string[],
  ): Promise<Set<string>>;

  /**
   * Marks `recipient`'s notifications `ids` (or all of them) read inside
   * `tx`; those read already keep their time. Returns how many it marked.
   */
  abstract markRead(
    tx: Transaction,
    recipient: string,
    ids: readonly string[] | 'all',
  ): Promise<number>;

  /**
   * Stores `notifications` inside `tx`; one already stored for the same
   * outbox row and recipient is left as it is (a batch read again). Returns
   * how many were new.
   */
  abstract add(
    tx: Transaction,
    notifications: readonly NewNotification[],
  ): Promise<number>;

  /** Deletes up to `limit` notifications read before `before`; how many. */
  abstract removeReadBefore(before: Date, limit: number): Promise<number>;
}
