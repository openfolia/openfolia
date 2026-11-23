import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './access.tables.js';

/**
 * One-time codes to sign in by email (#634): at most one per user, its code and the link in its
 * email together. The code only as an HMAC under a key derived from the instance secret key
 * (`DrizzleEmailCodeHasher`), the link only as the SHA-256 of its token, never either, and the
 * address it went to, which must still be the person's (#646). A new one replaces the one before
 * it; using it (by the code or the link) removes it. Deleting a user removes it. Apart from `sign_in_links`, so a code never replaces an invite.
 */
export const emailSignInCodes = pgTable(
  'email_sign_in_codes',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    linkHash: text('link_hash')
      .notNull()
      .unique('email_sign_in_codes_link_hash_key'),
    /**
     * The address it was mailed to (#646), as the person had it then: the code and its link work
     * only while it is still theirs (ignoring case), whatever path changed it.
     */
    sentTo: text('sent_to').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Wrong codes tried against it: at `EMAIL_CODE_MAX_FAILURES` it is removed. */
    failures: integer('failures').notNull().default(0),
  },
  (t) => [
    check('email_sign_in_codes_failures', sql`${t.failures} >= 0`),
    check(
      'email_sign_in_codes_code_hash_format',
      sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'email_sign_in_codes_link_hash_format',
      sql`${t.linkHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * The users who have signed in with a code by email (#634), from their first time: a way in of
 * their own, so `CCMS_OIDC_LINK_BY_EMAIL=pending` never joins a provider to them (as an identity
 * or a password does). Never removed but with the user.
 */
export const emailCodeSignIns = pgTable('email_code_sign_ins', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
});
