import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  Notification,
  NotificationKind,
  NotificationSubject,
} from './notification.js';

/** How a notification goes out by email: on its own (`now`) or in the daily summary. */
export type EmailMode = 'now' | 'digest';

/** A notification to email, named by its outbox row and recipient (what makes it unique). */
export interface ScheduledEmail {
  readonly outboxId: number;
  readonly recipient: string;
  readonly mode: EmailMode;
}

/** Emails due to go out together: a burst of one kind on one subject, or a person's summary. */
export type EmailGroup =
  | {
      readonly mode: 'now';
      readonly recipient: string;
      readonly kind: NotificationKind;
      readonly subject: NotificationSubject;
    }
  | { readonly mode: 'digest'; readonly recipient: string };

/** A person with a summary waiting, and since when. */
export interface WaitingDigest {
  readonly recipient: string;
  /** When the oldest notification waiting for it came. */
  readonly oldest: Date;
}

/** Rows a sender holds for a while (`lease`), and their notifications. */
export interface ClaimedEmails {
  readonly claim: string;
  readonly items: readonly {
    readonly id: number;
    readonly notification: Notification;
  }[];
}

/** What a sent email is recorded as: its idempotency key, and whom it went to. */
export interface EmailSend {
  readonly key: string;
  readonly recipient: string;
  readonly mode: EmailMode;
}

/**
 * Port: the notifications waiting to go out by email (#884, `notification_emails`) and the
 * emails sent (`notification_email_sends`). A row is scheduled with its notification, claimed by
 * one sender for a lease, and removed in the transaction that queues its email (`complete`), so
 * a restart neither loses nor doubles one.
 */
export abstract class NotificationEmailQueue {
  /**
   * Schedules each email of `emails` whose notification is stored (in `tx`, the transaction
   * that stores them); one scheduled already is left as it is. How many are new.
   */
  abstract schedule(
    tx: Transaction,
    emails: readonly ScheduledEmail[],
  ): Promise<number>;

  /**
   * The bursts due: groups of `now` rows (one recipient, kind and subject) not held by a
   * sender, whose oldest row came at or before `before`; oldest first, at most `limit`.
   */
  abstract dueNow(before: Date, limit: number): Promise<EmailGroup[]>;

  /** The people with `digest` rows not held by a sender, and their oldest row's time. */
  abstract waitingDigests(limit: number): Promise<WaitingDigest[]>;

  /**
   * Holds up to `limit` of the group's rows not held by another sender (or whose lease ran
   * out) for `leaseMs`, oldest first; undefined when there are none.
   */
  abstract claim(
    group: EmailGroup,
    leaseMs: number,
    limit: number,
  ): Promise<ClaimedEmails | undefined>;

  /**
   * Inside `tx` (which queues the email): removes the rows `ids` still held by `claim`, and
   * records `send`. False when none of them is held by `claim` any more (its lease ran out and
   * another sender took them: nothing written), or when `send.key` was recorded already (that
   * email went out: the rows are removed all the same). Throws, so `tx` rolls back, when only
   * some of them are still held.
   */
  abstract complete(
    tx: Transaction,
    claim: string,
    ids: readonly number[],
    send: EmailSend,
  ): Promise<boolean>;

  /**
   * Lets go of the rows `ids` held by `claim`: `drop` removes them (they go out no more),
   * `digest` moves them to the person's summary.
   */
  abstract release(
    claim: string,
    ids: readonly number[],
    to: 'drop' | 'digest',
  ): Promise<void>;

  /** How many notification emails went to `recipient` since `since` (the hourly cap). */
  abstract sentSince(recipient: string, since: Date): Promise<number>;

  /**
   * Removes the sends recorded and the rows scheduled before `before` (rows never sent: mail
   * was off since); how many, at most `limit` of each.
   */
  abstract prune(before: Date, limit: number): Promise<number>;
}
