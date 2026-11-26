import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from '../../access/repos/access.tables.js';

/**
 * Each person's own preferences (#222), one row per user, made by their first change (a person
 * without one has the defaults). `show_tips`: the editor shows tips and the tour;
 * `dismissed_tips`: the tip IDs the person closed (at most 500); `tour_done`: the first-run tour
 * was finished or skipped. Notifications (#884): `notification_choices`, the kinds the person
 * chose for (`{ "<kind>": "off" | "app" | "email" | "digest" }`, the others take their default);
 * `email_paused` ("Pause all email"); `notifications_off` ("Turn off all notifications");
 * `digest_hour`, `time_zone` and `language` for their email (null: the defaults). Goes with the
 * user.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    showTips: boolean('show_tips').notNull().default(true),
    dismissedTips: text('dismissed_tips')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    tourDone: boolean('tour_done').notNull().default(false),
    notificationChoices: jsonb('notification_choices')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    emailPaused: boolean('email_paused').notNull().default(false),
    notificationsOff: boolean('notifications_off').notNull().default(false),
    digestHour: smallint('digest_hour'),
    timeZone: text('time_zone'),
    language: text('language'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'user_preferences_dismissed_tips',
      sql`cardinality(${t.dismissedTips}) <= 500`,
    ),
    check(
      'user_preferences_notification_choices',
      sql`jsonb_typeof(${t.notificationChoices}) = 'object'`,
    ),
    check(
      'user_preferences_digest_hour',
      sql`${t.digestHour} is null or ${t.digestHour} between 0 and 23`,
    ),
    check(
      'user_preferences_time_zone',
      sql`${t.timeZone} is null or char_length(${t.timeZone}) between 1 and 64`,
    ),
    check(
      'user_preferences_language',
      sql`${t.language} is null or ${t.language} in ('en', 'de')`,
    ),
  ],
);
