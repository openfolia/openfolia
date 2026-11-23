import { z } from 'zod';

/**
 * What a notification is about: its kind is the outbox topic it came from.
 * A topic not listed here notifies nobody.
 */
export const NOTIFICATION_KINDS = [
  'change-set.submit',
  'change-set.return',
  'change-set.approve',
  'change-set.sign-off',
  'change-set.merge',
  'lock.break',
  'translation.imported',
  'translation.import-failed',
  'release.published',
  'release.output-failed',
  'release.output-recovered',
  'backup.failed',
  'backup.overdue',
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** The kinds of thing a notification opens. */
export const SUBJECT_TYPES = [
  'change-set',
  'release',
  'import',
  'backup',
] as const;
export const NotificationSubjectType = z.enum(SUBJECT_TYPES);
export type NotificationSubjectType = z.infer<typeof NotificationSubjectType>;

export interface NotificationSubject {
  readonly type: NotificationSubjectType;
  readonly id: string;
}

/** Who caused an event, as the audit log names actors. */
export interface EventActor {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

/** A notification about to be stored: one per outbox row and recipient. */
export interface NewNotification {
  /** The outbox row it came from: with the recipient, what makes it unique. */
  readonly outboxId: number;
  /** A user's ID: only people are notified. */
  readonly recipient: string;
  readonly kind: NotificationKind;
  readonly subject: NotificationSubject;
  /**
   * What a client builds its sentence from (IDs, a title, a state), never
   * text written for people on the server, and nothing the recipient may
   * not read.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** When the event happened (its outbox row's time). */
  readonly createdAt: Date;
}

/** A stored notification. */
export interface Notification extends NewNotification {
  /** Decimal text; increasing in the order notifications were stored. */
  readonly id: string;
  /** When its recipient marked it read; undefined while unread. */
  readonly readAt?: Date;
}

/** A notification's ID in requests: a positive whole number, as decimal text. */
export const NotificationId = z
  .string()
  // At most 15 digits: exact as a JavaScript number.
  .regex(/^[1-9][0-9]{0,14}$/, 'a notification ID (a positive whole number)');

/** The most IDs one `POST /me/notifications/read` takes. */
export const MAX_MARKED = 200;
