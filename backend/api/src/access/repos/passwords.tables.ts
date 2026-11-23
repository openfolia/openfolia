import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './access.tables.js';

/**
 * Users' password hashes (#610): argon2id in the PHC string format, never the password; one
 * per user at most. Deleting a user removes it.
 */
export const userPasswords = pgTable(
  'user_passwords',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'user_passwords_hash_format',
      sql`${t.hash} like '$argon2id$%' and char_length(${t.hash}) <= 512`,
    ),
  ],
);

/**
 * One-time links to set a password (#610): an invite or a reset. Only the SHA-256 of the
 * token (lowercase hex), never the token. At most one per user: a new one replaces the one
 * before it. Removed when used. Deleting a user removes it.
 */
export const signInLinks = pgTable(
  'sign_in_links',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .unique('sign_in_links_user_id_key')
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'sign_in_links_token_hash_format',
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('sign_in_links_kind', sql`${t.kind} in ('invite', 'reset')`),
  ],
);

/**
 * Password attempts per account (#610), for the lockout: per key (`sign-in:` or `reset:` and an
 * email address, or `user:<id>`), how many attempts failed (or reset requests came) in the
 * window that began at `window_start`. The key only as an HMAC (`DrizzlePasswordAttempts`),
 * never the address: an address nobody has and one somebody has are stored and expire alike.
 * Ended windows are deleted.
 */
export const passwordAttempts = pgTable(
  'password_attempts',
  {
    keyHash: text('key_hash').primaryKey(),
    failures: integer('failures').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'password_attempts_key_hash_format',
      sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('password_attempts_failures', sql`${t.failures} >= 0`),
    index('password_attempts_window_start_idx').on(t.windowStart),
  ],
);

/**
 * The password lockout's HMAC key (#610) when the instance has no secret key to derive it
 * from: made once, at random, and shared by every server on this database. One row at most.
 */
export const passwordAttemptsKey = pgTable(
  'password_attempts_key',
  {
    id: integer('id').primaryKey(),
    key: text('key').notNull(),
  },
  (t) => [
    check('password_attempts_key_one', sql`${t.id} = 1`),
    check('password_attempts_key_format', sql`${t.key} ~ '^[0-9a-f]{64}$'`),
  ],
);
