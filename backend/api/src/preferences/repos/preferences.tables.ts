import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from '../../access/repos/access.tables.js';

/**
 * Each person's own preferences (#222), one row per user, made by their first change (a person
 * without one has the defaults). `show_tips`: the editor shows tips and the tour;
 * `dismissed_tips`: the tip IDs the person closed (at most 500); `tour_done`: the first-run tour
 * was finished or skipped. Goes with the user.
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
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'user_preferences_dismissed_tips',
      sql`cardinality(${t.dismissedTips}) <= 500`,
    ),
  ],
);
