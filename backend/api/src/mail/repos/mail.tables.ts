import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Emails waiting to be sent (#609), the mail component's outbox: a row is written in the
 * transaction of what caused it, beside its `mail.send` job, and removed once the email went
 * out or failed for good, so nothing of an email is kept after sending. `params_sealed` holds the
 * template's params, sealed under the instance secret key (`SecretSealer`, context
 * `mail-params:v1:<id>`), as they may carry a sign-in link. The body is never stored: it is
 * rendered when it is sent.
 */
export const mailMessages = pgTable(
  'mail_messages',
  {
    id: uuid('id').primaryKey(),
    toAddress: text('to_address').notNull(),
    toName: text('to_name'),
    template: text('template').notNull(),
    language: text('language').notNull(),
    paramsSealed: text('params_sealed').notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** The last failed attempt's error kind (`rejected`, `unavailable`, `tls`, `auth`). */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('mail_messages_created_at').on(t.createdAt),
    check(
      'mail_messages_to_address',
      sql`char_length(${t.toAddress}) between 3 and 254`,
    ),
    check(
      'mail_messages_to_name',
      sql`${t.toName} is null or char_length(${t.toName}) between 1 and 200`,
    ),
    check(
      'mail_messages_template',
      sql`${t.template} ~ '^[a-z][a-z0-9-]*$' and char_length(${t.template}) <= 64`,
    ),
    check('mail_messages_language', sql`${t.language} ~ '^[a-z]{2}$'`),
    check(
      'mail_messages_last_error',
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 32`,
    ),
  ],
);
