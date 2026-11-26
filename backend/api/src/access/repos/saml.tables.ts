import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The SAML assertions accepted (#376, `SeenAssertions`), each until the last moment it would
 * still be valid, so a copy posted again (to any server) is refused. The key (the identity
 * provider's entity ID and the assertion's ID) only as its SHA-256, so its length is bounded.
 * Rows past their time are deleted by the next sign-in.
 */
export const samlSeenAssertions = pgTable(
  'saml_seen_assertions',
  {
    keyHash: text('key_hash').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('saml_seen_assertions_expires_at_idx').on(t.expiresAt),
    check(
      'saml_seen_assertions_key_hash_format',
      sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
