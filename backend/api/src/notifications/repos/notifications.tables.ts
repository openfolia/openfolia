import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * A person's inbox (#252): one row per outbox row and recipient, made by
 * the fan-out (`DeliverNotificationsAction`). `recipient_id` is a user's
 * ID (only people are notified); `kind` the outbox topic; `subject` what
 * it opens (a change set, a release, an import); `payload` what a client
 * builds its sentence from; `created_at` when the event happened (its
 * outbox row's time); `read_at` when its recipient marked it read.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    outboxId: bigint('outbox_id', { mode: 'number' }).notNull(),
    recipientId: text('recipient_id').notNull(),
    kind: text('kind').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    // A batch read again (a restart, two servers) notifies nobody twice.
    uniqueIndex('notifications_outbox_recipient').on(t.outboxId, t.recipientId),
    index('notifications_recipient').on(
      t.recipientId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('notifications_unread')
      .on(t.recipientId, t.id)
      .where(sql`${t.readAt} is null`),
    index('notifications_read')
      .on(t.readAt)
      .where(sql`${t.readAt} is not null`),
    check(
      'notifications_recipient_id',
      sql`char_length(${t.recipientId}) <= 64 and ${t.recipientId} ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'`,
    ),
    check(
      'notifications_kind',
      sql`${t.kind} ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$' and char_length(${t.kind}) <= 100`,
    ),
    check(
      'notifications_subject',
      sql`${t.subjectType} ~ '^[a-z][a-z0-9-]*$' and char_length(${t.subjectType}) <= 50 and char_length(${t.subjectId}) between 1 and 200`,
    ),
    check('notifications_payload', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);
