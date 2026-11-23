import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The read scopes a change-feed cursor names (#43), by their digest
 * (`FeedScopes`): a cursor holds only the digest of its reader's
 * `content.read` scopes, so it stays short however many scopes a reader
 * holds, and the feed reads them back here to tell a reader whose scope
 * narrowed what left it. Content-addressed: a digest always names the same
 * scopes, so rows are only ever added; none is changed.
 */
export const changeFeedScopes = pgTable(
  'change_feed_scopes',
  {
    /** SHA-256 hex of the scopes' canonical JSON (`scopeDigest`). */
    digest: text('digest').primaryKey(),
    /** The `content.read` scopes, canonical (sorted, each once). */
    scopes: jsonb('scopes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('change_feed_scopes_digest', sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
    check(
      'change_feed_scopes_scopes',
      sql`jsonb_typeof(${t.scopes}) = 'array'`,
    ),
  ],
);
