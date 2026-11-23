import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { roles } from './access.tables.js';

/**
 * Machine clients (a portal build, a retrieval pipeline, an agent) with
 * roles of their own (#38). The ID has `UserId`'s format; as an actor it is
 * `{ kind: 'service', id }`, which never matches a user (every check
 * compares the kind too). `deactivated_at` set means none of its tokens
 * authenticates.
 */
export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** What it is for; null for none. */
    description: text('description'),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'service_accounts_id_format',
      sql`char_length(${t.id}) <= 64 and ${t.id} ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'`,
    ),
    check(
      'service_accounts_name_length',
      sql`char_length(${t.name}) between 1 and 200`,
    ),
    check(
      'service_accounts_description_length',
      sql`${t.description} is null or char_length(${t.description}) between 1 and 500`,
    ),
  ],
);

/** Which service account holds which role. A role still held cannot be deleted. */
export const serviceAccountRoles = pgTable(
  'service_account_roles',
  {
    serviceAccountId: text('service_account_id')
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.serviceAccountId, t.roleId] }),
    index('service_account_roles_role_id_idx').on(t.roleId),
  ],
);

/**
 * A service account's API tokens. Only the SHA-256 of a token is stored
 * (`secret_hash`, lowercase hex), never the token: it is shown once, when
 * issued. `id` is the token's public part (`ccms_sat_<id>_<secret>`), by
 * which a presented token is looked up. A token authenticates while it is
 * neither revoked nor expired and its account is active; `last_used_at`
 * is kept to the minute.
 */
export const serviceTokens = pgTable(
  'service_tokens',
  {
    id: text('id').primaryKey(),
    serviceAccountId: text('service_account_id')
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: 'cascade' }),
    /** What the token is for, e.g. "portal build, production". */
    name: text('name').notNull(),
    secretHash: text('secret_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    check('service_tokens_id_format', sql`${t.id} ~ '^[0-9a-f]{16}$'`),
    check(
      'service_tokens_name_length',
      sql`char_length(${t.name}) between 1 and 100`,
    ),
    check(
      'service_tokens_secret_hash_format',
      sql`${t.secretHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'service_tokens_expires_after_created',
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
    index('service_tokens_account_idx').on(t.serviceAccountId, t.createdAt),
  ],
);
