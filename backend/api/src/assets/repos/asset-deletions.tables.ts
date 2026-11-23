import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Files being or having been deleted as unused (#255): a mark set under
 * the hash's lock before the last check of where a file is used, so a
 * working copy saved meanwhile that names it is refused rather than left
 * pointing at a deleted blob. An upload of the same bytes clears it.
 */
export const assetDeletions = pgTable(
  'asset_deletions',
  {
    sha256: text('sha256').primaryKey(),
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('asset_deletions_sha256', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`)],
);
