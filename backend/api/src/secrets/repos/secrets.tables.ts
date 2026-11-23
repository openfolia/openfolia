import { sql } from 'drizzle-orm';
import { check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The instance secret key's check (#470): one row, a fixed text sealed
 * under the key (never the key, nor anything that gives it away). Written
 * by the first start that has a key; every later start must open it, so a
 * lost key file, another key, or a second server that made its own key is
 * refused before it seals anything. Re-sealed by a rotation, like every
 * sealed secret.
 */
export const secretKeyCheck = pgTable(
  'secret_key_check',
  {
    id: smallint('id').primaryKey().default(1),
    sealed: text('sealed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check('secret_key_check_one_row', sql`${t.id} = 1`)],
);
