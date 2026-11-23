import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { roles, users } from './access.tables.js';

/**
 * Which person at which identity provider is which user (#37): the
 * provider's issuer and subject, and the groups it sent at their last
 * sign-in (what the group mappings apply to). One identity per issuer and
 * user. Deleting a user removes its identities.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groups: text('groups')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.issuer, t.subject] }),
    unique('user_identities_user_issuer').on(t.userId, t.issuer),
    // `usersInGroup`: who was last seen in a group.
    index('user_identities_groups_idx').using('gin', t.groups),
    check(
      'user_identities_lengths',
      sql`char_length(${t.issuer}) between 1 and 2000 and char_length(${t.subject}) between 1 and 255 and cardinality(${t.groups}) <= 200`,
    ),
  ],
);

/**
 * A group's members hold a role (#37). A role a mapping gives cannot be
 * deleted (`restrict`) until the mapping is removed.
 */
export const groupRoles = pgTable(
  'group_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    group: text('group_name').notNull(),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('group_roles_group_role').on(t.group, t.roleId),
    index('group_roles_role_id_idx').on(t.roleId),
    check(
      'group_roles_group_length',
      sql`char_length(${t.group}) between 1 and 256`,
    ),
  ],
);

/**
 * People's sessions (#37): the SHA-256 of the token only (lowercase hex),
 * never the token. Its limits are the session policy's, asked on every
 * request. Deleting a user removes its sessions.
 */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    check('sessions_token_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
