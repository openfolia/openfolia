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
} from 'drizzle-orm/pg-core';

/**
 * People who use the system. Sign-in (later) links them to an identity.
 * The ID's format is `UserId`'s (`core/actor.ts`), held here too, so no
 * stored user is one `findActor` cannot look up. `email` is optional (a
 * seeded user may have none) and unique ignoring case; `deactivated_at` set
 * means the user cannot act (#39).
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      'users_id_format',
      sql`char_length(${t.id}) <= 64 and ${t.id} ~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'`,
    ),
    // `UserEmail`'s format (`core/actor.ts`), loosely: one "@", no spaces.
    check(
      'users_email_format',
      sql`${t.email} is null or (char_length(${t.email}) <= 254 and ${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$')`,
    ),
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
  ],
);

/**
 * Roles: a named set of permissions and the scope they apply in. Each scope
 * column is null for "all" and otherwise a non-empty list. The values are
 * checked when a role is read (`toRole` in `drizzle-user-directory.ts`), so an unknown permission fails
 * loudly instead of being dropped.
 */
export const roles = pgTable(
  'roles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** What the role is for, for the people assigning it; null for none. */
    description: text('description'),
    permissions: text('permissions').array().notNull(),
    languages: text('languages').array(),
    moduleTypes: text('module_types').array(),
    maxAudience: text('max_audience'),
    /** `{ "<facet>": ["<value>", …] }`; a facet not named is not restricted. */
    facets: jsonb('facets').$type<Record<string, string[]>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // `RoleId`'s format (`core/actor.ts`).
    check(
      'roles_id_format',
      sql`char_length(${t.id}) <= 64 and ${t.id} ~ '^[a-z][a-z0-9-]*$'`,
    ),
    check(
      'roles_description_length',
      sql`${t.description} is null or char_length(${t.description}) between 1 and 500`,
    ),
    check(
      'roles_permissions_not_empty',
      sql`cardinality(${t.permissions}) > 0`,
    ),
    check(
      'roles_languages_not_empty',
      sql`${t.languages} is null or cardinality(${t.languages}) > 0`,
    ),
    check(
      'roles_module_types_not_empty',
      sql`${t.moduleTypes} is null or cardinality(${t.moduleTypes}) > 0`,
    ),
    check(
      'roles_facets_not_empty',
      sql`${t.facets} is null or (jsonb_typeof(${t.facets}) = 'object' and ${t.facets} <> '{}'::jsonb)`,
    ),
  ],
);

/**
 * Which user holds which role. A role still assigned cannot be deleted.
 * A row says which way the role is held (#37): `direct` (assigned by an
 * admin or the seed) and `via_groups` (through a group mapping, from the
 * groups the user's identity provider sent), at least one of them; a row
 * neither is removed. Every check of who holds what reads the rows alone,
 * either way.
 */
export const roleAssignments = pgTable(
  'role_assignments',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    direct: boolean('direct').notNull().default(true),
    viaGroups: boolean('via_groups').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index('role_assignments_role_id_idx').on(t.roleId),
    check('role_assignments_held', sql`${t.direct} or ${t.viaGroups}`),
  ],
);
