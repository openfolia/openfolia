import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../../access/repos/access.tables.js';

/**
 * The users a directory provisions over SCIM (#377): a link from a user to the directory's
 * `userName` (unique ignoring case, as SCIM compares it) and `externalId`, and the attributes it
 * sent, kept as it sent them (`attributes`, without `id`, `meta`, `active`, `groups` and any
 * password) so a read gives them back. Who the user is and whether they may act stay in `users`
 * (`name`, `email`, `deactivated_at`). Deleting the user removes the link.
 */
export const scimUsers = pgTable(
  'scim_users',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    userName: text('user_name').notNull(),
    externalId: text('external_id'),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Made by the directory (true), or an existing user it linked by email (false). */
    createdByScim: boolean('created_by_scim').notNull().default(false),
    /**
     * When the directory deactivated the user, as `users.deactivated_at` then was; null when it
     * did not. The directory may reactivate only a user still deactivated at that moment: never
     * one an admin deactivated.
     */
    scimDeactivatedAt: timestamp('scim_deactivated_at', { withTimezone: true }),
    /**
     * When the directory let the user go (a DELETE); null while provisioned. The row stays, so
     * the directory may provision the same person again (`ScimDirectory.formerLink`); a let-go
     * user is otherwise as if never provisioned.
     */
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('scim_users_user_name_unique')
      .on(sql`lower(${t.userName})`)
      .where(sql`${t.unlinkedAt} is null`),
    check(
      'scim_users_lengths',
      sql`char_length(${t.userName}) between 1 and 256 and (${t.externalId} is null or char_length(${t.externalId}) between 1 and 256)`,
    ),
  ],
);

/**
 * The groups a directory provisions over SCIM (#377). `display_name` is the group's name the
 * group mappings match (`group_roles.group_name`, exactly, case included), so it is unique.
 */
export const scimGroups = pgTable(
  'scim_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('scim_groups_display_name_unique').on(t.displayName),
    check(
      'scim_groups_lengths',
      sql`char_length(${t.displayName}) between 1 and 256 and (${t.externalId} is null or char_length(${t.externalId}) between 1 and 256)`,
    ),
  ],
);

/**
 * Who is in which SCIM group (#377): what the group mappings give roles by, beside the groups an
 * identity provider sends at sign-in (`user_identities.groups`). Removing the group or the user
 * removes the membership.
 */
export const scimGroupMembers = pgTable(
  'scim_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => scimGroups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('scim_group_members_user_id_idx').on(t.userId),
  ],
);
