import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './access.tables.js';

/**
 * People's second factors (#611), at most one each: the authenticator app's secret, sealed with
 * the instance key, never in the clear. `confirmed_at` is null while its set-up is open (it
 * counts for nothing then). `last_step` is the time step of the last code accepted, so a code
 * is accepted once. Deleting a user removes it.
 */
export const secondFactors = pgTable(
  'second_factors',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    sealedSecret: text('sealed_secret').notNull(),
    begunAt: timestamp('begun_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    lastStep: bigint('last_step', { mode: 'number' }),
  },
  (t) => [
    check(
      'second_factors_sealed_secret_length',
      sql`char_length(${t.sealedSecret}) between 1 and 1000`,
    ),
    check(
      'second_factors_confirmed_step',
      sql`(${t.confirmedAt} is null) = (${t.lastStep} is null)`,
    ),
  ],
);

/**
 * The recovery codes of a second factor (#611): each only as the SHA-256 of it and its person,
 * removed when used. Removing the factor removes them.
 */
export const secondFactorRecoveryCodes = pgTable(
  'second_factor_recovery_codes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => secondFactors.userId, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.codeHash] }),
    check(
      'second_factor_recovery_codes_hash_format',
      sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Sign-ins whose first factor was right and whose second is still open (#611): no session. Only
 * the SHA-256 of the token in the browser's cookie. Removed when used. Deleting a user removes
 * theirs.
 */
export const pendingSignIns = pgTable(
  'pending_sign_ins',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `verify` a factor that is on, or `set-up` one the installation requires. */
    step: text('step').notNull(),
    /** The provider of the session it becomes. */
    provider: text('provider').notNull(),
    /** How an email code was given; null for a password. */
    via: text('via'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('pending_sign_ins_user_id_idx').on(t.userId, t.createdAt),
    check(
      'pending_sign_ins_token_hash_format',
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('pending_sign_ins_step', sql`${t.step} in ('verify', 'set-up')`),
    check(
      'pending_sign_ins_provider_length',
      sql`char_length(${t.provider}) between 1 and 100`,
    ),
  ],
);
