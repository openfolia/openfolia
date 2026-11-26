import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type ClaimedEmails,
  type EmailGroup,
  type EmailMode,
  type EmailSend,
  NotificationEmailQueue,
  type ScheduledEmail,
  type WaitingDigest,
} from '../../src/notifications/core/notification-email-queue.js';
import type { FakeNotificationStore } from './fake-notification-store.js';
import { fakeOf } from './fake-unit-of-work.js';

interface Row {
  id: number;
  notificationId: string;
  recipient: string;
  mode: EmailMode;
  createdAt: Date;
  claim: string | null;
  claimedUntil: number;
}

/**
 * The email queue in memory, over a `FakeNotificationStore`'s notifications; writes in a
 * transaction apply when it commits. `now` is the test's clock.
 */
export class FakeNotificationEmailQueue extends NotificationEmailQueue {
  readonly rows: Row[] = [];
  readonly sends: (EmailSend & { sentAt: Date })[] = [];
  now: () => number = Date.now;
  private nextId = 1;

  constructor(private readonly notifications: FakeNotificationStore) {
    super();
  }

  async schedule(
    tx: Transaction,
    emails: readonly ScheduledEmail[],
  ): Promise<number> {
    const transaction = fakeOf(tx);
    let count = 0;
    for (const e of emails) {
      count++;
      transaction.onCommit(() => {
        const n = this.notifications.stored.find(
          (s) => s.outboxId === e.outboxId && s.recipient === e.recipient,
        );
        if (!n || this.rows.some((r) => r.notificationId === n.id)) return;
        this.rows.push({
          id: this.nextId++,
          notificationId: n.id,
          recipient: e.recipient,
          mode: e.mode,
          createdAt: new Date(this.now()),
          claim: null,
          claimedUntil: 0,
        });
      });
    }
    return count;
  }

  private free(r: Row): boolean {
    return r.claim === null || r.claimedUntil < this.now();
  }

  private notificationOf(r: Row) {
    return this.notifications.stored.find((n) => n.id === r.notificationId)!;
  }

  async dueNow(before: Date, limit: number): Promise<EmailGroup[]> {
    const groups = new Map<string, { group: EmailGroup; oldest: number }>();
    for (const r of this.rows) {
      if (r.mode !== 'now' || !this.free(r)) continue;
      const n = this.notificationOf(r);
      const key = `${r.recipient}|${n.kind}|${n.subject.type}|${n.subject.id}`;
      const at = groups.get(key);
      if (!at || r.createdAt.getTime() < at.oldest) {
        groups.set(key, {
          group: {
            mode: 'now',
            recipient: r.recipient,
            kind: n.kind,
            subject: n.subject,
          },
          oldest: Math.min(at?.oldest ?? Infinity, r.createdAt.getTime()),
        });
      }
    }
    return [...groups.values()]
      .filter((g) => g.oldest <= before.getTime())
      .sort((a, b) => a.oldest - b.oldest)
      .slice(0, limit)
      .map((g) => g.group);
  }

  async waitingDigests(limit: number): Promise<WaitingDigest[]> {
    const oldest = new Map<string, number>();
    for (const r of this.rows) {
      if (r.mode !== 'digest' || !this.free(r)) continue;
      oldest.set(
        r.recipient,
        Math.min(oldest.get(r.recipient) ?? Infinity, r.createdAt.getTime()),
      );
    }
    return [...oldest]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([recipient, at]) => ({ recipient, oldest: new Date(at) }));
  }

  async claim(
    group: EmailGroup,
    leaseMs: number,
    limit: number,
  ): Promise<ClaimedEmails | undefined> {
    const claim = randomUUID();
    const held = this.rows
      .filter((r) => {
        if (r.recipient !== group.recipient || r.mode !== group.mode) {
          return false;
        }
        if (!this.free(r)) return false;
        if (group.mode === 'digest') return true;
        const n = this.notificationOf(r);
        return (
          n.kind === group.kind &&
          n.subject.type === group.subject.type &&
          n.subject.id === group.subject.id
        );
      })
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    if (held.length === 0) return undefined;
    for (const r of held) {
      r.claim = claim;
      r.claimedUntil = this.now() + leaseMs;
    }
    return {
      claim,
      items: held.map((r) => ({
        id: r.id,
        notification: this.notificationOf(r),
      })),
    };
  }

  async complete(
    tx: Transaction,
    claim: string,
    ids: readonly number[],
    send: EmailSend,
  ): Promise<boolean> {
    const mine = this.rows.filter(
      (r) => r.claim === claim && ids.includes(r.id),
    );
    if (mine.length === 0) return false;
    if (mine.length !== ids.length) {
      throw new Error('Notification email rows were taken over while sending.');
    }
    const sentAlready = this.sends.some((s) => s.key === send.key);
    fakeOf(tx).onCommit(() => {
      for (const r of mine) this.rows.splice(this.rows.indexOf(r), 1);
      if (!sentAlready)
        this.sends.push({ ...send, sentAt: new Date(this.now()) });
    });
    return !sentAlready;
  }

  async release(
    claim: string,
    ids: readonly number[],
    to: 'drop' | 'digest',
  ): Promise<void> {
    for (const r of this.rows.filter(
      (r) => r.claim === claim && ids.includes(r.id),
    )) {
      if (to === 'drop') this.rows.splice(this.rows.indexOf(r), 1);
      else Object.assign(r, { mode: 'digest', claim: null, claimedUntil: 0 });
    }
  }

  async sentSince(recipient: string, since: Date): Promise<number> {
    return this.sends.filter(
      (s) => s.recipient === recipient && s.sentAt >= since,
    ).length;
  }

  async prune(before: Date): Promise<number> {
    const old = this.sends.filter((s) => s.sentAt < before);
    for (const s of old) this.sends.splice(this.sends.indexOf(s), 1);
    return old.length;
  }
}
