import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../../access/repos/access.tables.js';
import { notifications } from './notifications.tables.js';

/**
 * The notifications waiting to go out by email (#884), the notifications' own outbox: a row is
 * written with its notification (same transaction, so a restart loses none), `mode` `now` (an
 * email of its own, a few minutes later so a burst becomes one) or `digest` (the daily summary).
 * The sender claims rows (`claim`, `claimed_until`: a lease, so a sender that dies hands them
 * back), and removes them in the transaction that queues their email, so none is sent twice.
 * Goes with its notification and with its recipient.
 */
export const notificationEmails = pgTable(
  'notification_emails',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    notificationId: bigint('notification_id', { mode: 'number' })
      .notNull()
      .unique('notification_emails_notification')
      .references(() => notifications.id, { onDelete: 'cascade' }),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    claim: uuid('claim'),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
  },
  (t) => [
    index('notification_emails_due').on(t.mode, t.createdAt),
    index('notification_emails_recipient').on(t.recipientId, t.mode),
    index('notification_emails_claim').on(t.claim),
    check('notification_emails_mode', sql`${t.mode} in ('now', 'digest')`),
  ],
);

/**
 * The notification emails queued (#884), by their idempotency key (`now:<recipient>:<first
 * notification ID>`, `digest:…`): a key already here is never queued again. Also what the hourly
 * cap per person counts. Kept three days (`KEEP_MS`).
 */
export const notificationEmailSends = pgTable(
  'notification_email_sends',
  {
    key: text('key').primaryKey(),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notification_email_sends_recipient').on(t.recipientId, t.sentAt),
    index('notification_email_sends_sent_at').on(t.sentAt),
    check('notification_email_sends_mode', sql`${t.mode} in ('now', 'digest')`),
    check(
      'notification_email_sends_key',
      sql`char_length(${t.key}) between 1 and 200`,
    ),
  ],
);
