import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from '../../access/repos/access.tables.js';

/**
 * The installation's settings (#588), in one row (`id` 1, made by the first change); each
 * setting a column of its own with its default. `version` counts the changes.
 * `self_approval`: who may approve their own change set (`never`, `review`,
 * `review-and-sign-off`). `second_factor`: who must sign in with a second factor (`optional`,
 * `admins`, `everyone`; #611). About signing in (#378), each null until it is set:
 * `single_sign_on`: whether people must sign in with an identity provider (`optional`,
 * `required`); `break_glass_user_id`: who may still sign in with their password then, never a
 * later holder of the ID; `session_idle_minutes` and `session_max_hours`: how long a session
 * lasts, null for the server's own limit.
 */
export const installationSettings = pgTable(
  'installation_settings',
  {
    id: smallint('id').primaryKey(),
    version: integer('version').notNull(),
    selfApproval: text('self_approval').notNull().default('never'),
    secondFactor: text('second_factor').notNull().default('optional'),
    singleSignOn: text('single_sign_on'),
    breakGlassUserId: text('break_glass_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sessionIdleMinutes: integer('session_idle_minutes'),
    sessionMaxHours: integer('session_max_hours'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('installation_settings_one_row', sql`${t.id} = 1`),
    check('installation_settings_version', sql`${t.version} >= 0`),
    check(
      'installation_settings_self_approval',
      sql`${t.selfApproval} in ('never', 'review', 'review-and-sign-off')`,
    ),
    check(
      'installation_settings_second_factor',
      sql`${t.secondFactor} in ('optional', 'admins', 'everyone')`,
    ),
    check(
      'installation_settings_single_sign_on',
      sql`${t.singleSignOn} in ('optional', 'required')`,
    ),
    check(
      'installation_settings_session_idle_minutes',
      sql`${t.sessionIdleMinutes} between 5 and 43200`,
    ),
    check(
      'installation_settings_session_max_hours',
      sql`${t.sessionMaxHours} between 1 and 8760`,
    ),
  ],
);
