import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * The installation's settings (#588), in one row (`id` 1, made by the first change); each
 * setting a column of its own with its default. `version` counts the changes.
 * `self_approval`: who may approve their own change set (`never`, `review`,
 * `review-and-sign-off`).
 */
export const installationSettings = pgTable(
  'installation_settings',
  {
    id: smallint('id').primaryKey(),
    version: integer('version').notNull(),
    selfApproval: text('self_approval').notNull().default('never'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('installation_settings_one_row', sql`${t.id} = 1`),
    check('installation_settings_version', sql`${t.version} >= 0`),
    check(
      'installation_settings_self_approval',
      sql`${t.selfApproval} in ('never', 'review', 'review-and-sign-off')`,
    ),
  ],
);
