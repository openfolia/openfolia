import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type {
  NewNotification,
  Notification,
} from '../../src/notifications/core/notification.js';
import {
  NotificationStore,
  type UnreadState,
} from '../../src/notifications/core/notification-store.js';
import { fakeOf } from './fake-unit-of-work.js';

type Stored = { -readonly [K in keyof Notification]: Notification[K] };

/** Notifications in memory; writes in a transaction apply when it commits. */
export class FakeNotificationStore extends NotificationStore {
  readonly stored: Stored[] = [];
  private nextId = 1;

  async list(
    recipient: string,
    filter: { readonly unread?: boolean },
    page: PageRequest,
  ) {
    const mine = this.mine(recipient);
    const listed = mine.filter(
      (n) =>
        filter.unread === undefined ||
        (n.readAt === undefined) === filter.unread,
    );
    return {
      ...paginate(listed, page),
      unreadCount: mine.filter((n) => n.readAt === undefined).length,
    };
  }

  async find(recipient: string, id: string) {
    return this.mine(recipient).find((n) => n.id === id);
  }

  async unread(recipient: string): Promise<UnreadState> {
    const mine = this.mine(recipient);
    return {
      count: mine.filter((n) => n.readAt === undefined).length,
      latest: mine.reduce<string | undefined>(
        (max, n) =>
          max === undefined || Number(n.id) > Number(max) ? n.id : max,
        undefined,
      ),
    };
  }

  async owned(tx: Transaction, recipient: string, ids: readonly string[]) {
    fakeOf(tx);
    const mine = new Set(this.mine(recipient).map((n) => n.id));
    return new Set(ids.filter((id) => mine.has(id)));
  }

  async markRead(
    tx: Transaction,
    recipient: string,
    ids: readonly string[] | 'all',
  ) {
    const marking = this.mine(recipient).filter(
      (n) => n.readAt === undefined && (ids === 'all' || ids.includes(n.id)),
    );
    const at = new Date();
    fakeOf(tx).onCommit(() => {
      for (const n of marking) n.readAt = at;
    });
    return marking.length;
  }

  async add(tx: Transaction, added: readonly NewNotification[]) {
    const transaction = fakeOf(tx);
    const fresh = added.filter(
      (a, i) =>
        !this.stored.some(
          (n) => n.outboxId === a.outboxId && n.recipient === a.recipient,
        ) &&
        added.findIndex(
          (b) => b.outboxId === a.outboxId && b.recipient === a.recipient,
        ) === i,
    );
    transaction.onCommit(() => {
      for (const n of fresh) {
        this.stored.push({ ...n, id: String(this.nextId++) });
      }
    });
    return fresh.length;
  }

  async removeReadBefore(before: Date, limit: number) {
    const old = this.stored
      .filter((n) => n.readAt !== undefined && n.readAt < before)
      .slice(0, limit);
    for (const n of old) this.stored.splice(this.stored.indexOf(n), 1);
    return old.length;
  }

  /** `recipient`'s, newest first. */
  private mine(recipient: string): Stored[] {
    return this.stored
      .filter((n) => n.recipient === recipient)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          Number(b.id) - Number(a.id),
      );
  }
}
